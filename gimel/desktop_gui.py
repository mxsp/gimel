"""Native Desktop Control Center & Master Admin UI for Gimel (`tkinter` / `ttk`).

Runs 100% natively in-process without starting any localhost HTTP server for
Master Admin or Setup. Provides one clean, single-screen dark window to:
- Start, stop, and open Gimel Production (:8041) and Playground (:8040)
- Toggle LAN sharing (`0.0.0.0` vs `127.0.0.1`)
- Directly create, reset password, unlock, activate/deactivate, and sign out
  accounts in the local Production and Playground SQLite databases.
"""

from __future__ import annotations

import ctypes
import os
import random
import threading
from pathlib import Path
from typing import Literal

from . import desktop, launcher, master_admin
from .localnet import local_lan_ips
from .version import APP_VERSION

EnvName = Literal["production", "playground"]

BG_MAIN = "#0f1216"
BG_CARD = "#161b22"
BG_INPUT = "#1d242d"
BG_BANNER = "#2b2111"
FG_BANNER = "#fbbf24"
BORDER_COLOR = "#2a333f"
TEXT_MAIN = "#f1f4f8"
TEXT_MUTED = "#8f9aa8"
ACCENT = "#0f8a73"
ACCENT_HOVER = "#129c82"
OK_GREEN = "#22c55e"
ERR_RED = "#ef4444"
DANGER_BG = "#261417"
DANGER_FG = "#fca5a5"

_PW_WORDS = (
    "Hobel",
    "Fraese",
    "Platte",
    "Ring",
    "Werkbank",
    "Laser",
    "Zange",
    "Feder",
    "Stahl",
    "Spindel",
)


def generate_password_suggestion() -> str:
    w1, w2 = random.sample(_PW_WORDS, 2)
    num = random.randint(10, 99)
    return f"{w1}-{w2}-{num}"


def _enable_windows_dpi_awareness() -> None:
    if os.name != "nt":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
        return
    except Exception:  # noqa: BLE001
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass


def _enable_windows_dark_titlebar(root) -> None:
    if os.name != "nt":
        return
    try:
        root.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(root.winfo_id()) or root.winfo_id()
        DWMWA_USE_IMMERSIVE_DARK_MODE = 20
        value = ctypes.c_int(1)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            ctypes.byref(value),
            ctypes.sizeof(value),
        )
    except Exception:  # noqa: BLE001
        pass


class GimelDesktopApp:
    """Single-screen native tkinter/ttk Master Admin & Server Control Center."""

    def __init__(
        self,
        root,
        *,
        base_dir: Path,
        host: str = launcher.DEFAULT_HOST,
        initial_view: str = "master",
    ) -> None:
        import tkinter as tk
        from tkinter import ttk

        self.tk = tk
        self.ttk = ttk
        self.root = root
        self.base_dir = base_dir
        self.initial_view = initial_view
        self.ctrl = master_admin.MasterAdminController(base_dir, host=host)

        self.current_env: EnvName = "production"
        self.accounts: list[dict] = []
        self._account_by_iid: dict[str, dict] = {}
        self._closing = False
        self._prefilled_initial_admin = False

        self.font_family = "Segoe UI" if os.name == "nt" else "sans-serif"

        self.root.title(f"Gimel Desktop & Master Admin — v{APP_VERSION}")
        self.root.configure(bg=BG_MAIN)
        self.root.geometry("980x700")
        self.root.minsize(860, 620)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        self._configure_styles()
        self._build_ui()
        _enable_windows_dark_titlebar(self.root)

        self.refresh_accounts(initial=True)
        self._schedule_status_poll()

    def _configure_styles(self) -> None:
        style = self.ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:  # noqa: BLE001
            pass

        ff = self.font_family
        style.configure(".", background=BG_MAIN, foreground=TEXT_MAIN, font=(ff, 10))
        style.configure(
            "Treeview",
            background=BG_INPUT,
            fieldbackground=BG_INPUT,
            foreground=TEXT_MAIN,
            bordercolor=BORDER_COLOR,
            lightcolor=BORDER_COLOR,
            darkcolor=BORDER_COLOR,
            rowheight=30,
            font=(ff, 10),
        )
        style.configure(
            "Treeview.Heading",
            background=BG_CARD,
            foreground=TEXT_MUTED,
            bordercolor=BORDER_COLOR,
            relief="flat",
            padding=(8, 6),
            font=(ff, 9, "bold"),
        )
        style.map(
            "Treeview",
            background=[("selected", ACCENT)],
            foreground=[("selected", "#ffffff")],
        )
        style.map(
            "Treeview.Heading",
            background=[("active", BG_INPUT)],
        )
        style.configure(
            "TCombobox",
            fieldbackground=BG_INPUT,
            background=BG_CARD,
            foreground=TEXT_MAIN,
            arrowcolor=TEXT_MAIN,
            bordercolor=BORDER_COLOR,
            lightcolor=BORDER_COLOR,
            darkcolor=BORDER_COLOR,
            padding=5,
        )
        style.map(
            "TCombobox",
            fieldbackground=[("readonly", BG_INPUT)],
            foreground=[("readonly", TEXT_MAIN)],
            selectbackground=[("readonly", BG_INPUT)],
            selectforeground=[("readonly", TEXT_MAIN)],
        )

    def _make_button(
        self,
        parent,
        text: str,
        command,
        *,
        kind: Literal["primary", "secondary", "danger"] = "secondary",
        padx: int = 12,
        pady: int = 6,
    ):
        tk = self.tk
        if kind == "primary":
            bg, fg, active_bg = ACCENT, "#ffffff", ACCENT_HOVER
        elif kind == "danger":
            bg, fg, active_bg = DANGER_BG, DANGER_FG, "#3a1b20"
        else:
            bg, fg, active_bg = BG_INPUT, TEXT_MAIN, "#283240"

        btn = tk.Button(
            parent,
            text=text,
            command=command,
            bg=bg,
            fg=fg,
            activebackground=active_bg,
            activeforeground=fg,
            disabledforeground="#586370",
            relief="flat",
            bd=0,
             highlightthickness=1,
            highlightbackground=BORDER_COLOR if kind != "primary" else ACCENT_HOVER,
            highlightcolor=ACCENT_HOVER,
            padx=padx,
            pady=pady,
            cursor="hand2",
            font=(self.font_family, 9, "bold" if kind == "primary" else "normal"),
        )
        return btn

    def _build_ui(self) -> None:
        tk = self.tk
        ff = self.font_family

        outer = tk.Frame(self.root, bg=BG_MAIN, padx=20, pady=16)
        outer.pack(fill="both", expand=True)

        # ── Header Bar ────────────────────────────────────────────────────────
        header = tk.Frame(outer, bg=BG_MAIN)
        header.pack(fill="x", pady=(0, 14))

        mark = tk.Label(
            header,
            text="ג",
            bg=ACCENT,
            fg="#ffffff",
            font=(ff, 16, "bold"),
            width=2,
            padx=4,
            pady=2,
        )
        mark.pack(side="left", padx=(0, 10))

        title_box = tk.Frame(header, bg=BG_MAIN)
        title_box.pack(side="left")

        title_row = tk.Frame(title_box, bg=BG_MAIN)
        title_row.pack(anchor="w")

        tk.Label(
            title_row,
            text="Gimel Desktop & Master Admin",
            bg=BG_MAIN,
            fg=TEXT_MAIN,
            font=(ff, 14, "bold"),
        ).pack(side="left")

        tk.Label(
            title_row,
            text=f"v{APP_VERSION}",
            bg="#0f2d24",
            fg="#5eead4",
            font=(ff, 9, "bold"),
            padx=8,
            pady=2,
        ).pack(side="left", padx=(10, 0))

        right_header = tk.Frame(header, bg=BG_MAIN)
        right_header.pack(side="right")

        self.lan_var = tk.BooleanVar(value=(self.ctrl.host == "0.0.0.0"))
        self.lan_check = tk.Checkbutton(
            right_header,
            text="Im lokalen Netzwerk (LAN) freigeben",
            variable=self.lan_var,
            command=self._on_toggle_lan,
            bg=BG_MAIN,
            fg=TEXT_MAIN,
            activebackground=BG_MAIN,
            activeforeground=TEXT_MAIN,
            selectcolor=BG_INPUT,
            highlightthickness=0,
            bd=0,
            font=(ff, 9),
            cursor="hand2",
        )
        self.lan_check.pack(side="right", padx=(12, 0))

        self.lan_label = tk.Label(
            right_header,
            text="",
            bg=BG_INPUT,
            fg=TEXT_MUTED,
            font=(ff, 9),
            padx=10,
            pady=4,
        )
        self.lan_label.pack(side="right")
        self._update_lan_label()

        # ── Section 1: Gimel Server starten & öffnen ─────────────────────────
        srv_card = tk.Frame(
            outer,
            bg=BG_CARD,
            padx=16,
            pady=14,
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
        )
        srv_card.pack(fill="x", pady=(0, 14))

        tk.Label(
            srv_card,
            text="Gimel Server starten & öffnen",
            bg=BG_CARD,
            fg=TEXT_MAIN,
            font=(ff, 11, "bold"),
        ).pack(anchor="w", pady=(0, 10))

        # Row 1: Production (8041)
        prod_row = tk.Frame(srv_card, bg=BG_INPUT, padx=12, pady=10)
        prod_row.pack(fill="x", pady=(0, 8))

        tk.Label(
            prod_row,
            text="Production (Echtbetrieb · Port 8041)",
            bg=BG_INPUT,
            fg=TEXT_MAIN,
            font=(ff, 10, "bold"),
            width=32,
            anchor="w",
        ).pack(side="left")

        self.badge_production = tk.Label(
            prod_row,
            text="○ Gestoppt",
            bg=BG_INPUT,
            fg=TEXT_MUTED,
            font=(ff, 9, "bold"),
            width=12,
            anchor="w",
        )
        self.badge_production.pack(side="left", padx=(4, 10))

        self.btn_stop_production = self._make_button(
            prod_row,
            "Stoppen",
            lambda: self.stop_server("production"),
            kind="danger",
            padx=10,
            pady=5,
        )
        self.btn_stop_production.pack(side="right", padx=(6, 0))

        self._make_button(
            prod_row,
            "Agent Lab",
            lambda: self.open_mode_url("production", "/lab/"),
            padx=10,
            pady=5,
        ).pack(side="right", padx=(6, 0))

        self._make_button(
            prod_row,
            "3D Twin Studio",
            lambda: self.open_mode_url("production", "/studio/"),
            padx=10,
            pady=5,
        ).pack(side="right", padx=(6, 0))

        self._make_button(
            prod_row,
            "ERP öffnen (Production)",
            lambda: self.open_mode_url("production", "/app/"),
            kind="primary",
            padx=14,
            pady=5,
        ).pack(side="right", padx=(6, 0))

        # Row 2: Playground (8040)
        play_row = tk.Frame(srv_card, bg=BG_INPUT, padx=12, pady=10)
        play_row.pack(fill="x")

        tk.Label(
            play_row,
            text="Playground (Demo-Werk · Port 8040)",
            bg=BG_INPUT,
            fg=TEXT_MAIN,
            font=(ff, 10, "bold"),
            width=32,
            anchor="w",
        ).pack(side="left")

        self.badge_playground = tk.Label(
            play_row,
            text="○ Gestoppt",
            bg=BG_INPUT,
            fg=TEXT_MUTED,
            font=(ff, 9, "bold"),
            width=12,
            anchor="w",
        )
        self.badge_playground.pack(side="left", padx=(4, 10))

        self.btn_stop_playground = self._make_button(
            play_row,
            "Stoppen",
            lambda: self.stop_server("playground"),
            kind="danger",
            padx=10,
            pady=5,
        )
        self.btn_stop_playground.pack(side="right", padx=(6, 0))

        self._make_button(
            play_row,
            "3D Twin Studio",
            lambda: self.open_mode_url("playground", "/studio/"),
            padx=10,
            pady=5,
        ).pack(side="right", padx=(6, 0))

        self._make_button(
            play_row,
            "Demo öffnen (Playground)",
            lambda: self.open_mode_url("playground", "/app/"),
            kind="primary",
            padx=14,
            pady=5,
        ).pack(side="right", padx=(6, 0))

        # ── Section 2: Master Admin — Kontenverwaltung ───────────────────────
        acc_card = tk.Frame(
            outer,
            bg=BG_CARD,
            padx=16,
            pady=14,
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
        )
        acc_card.pack(fill="both", expand=True, pady=(0, 10))

        acc_head = tk.Frame(acc_card, bg=BG_CARD)
        acc_head.pack(fill="x", pady=(0, 10))

        tk.Label(
            acc_head,
            text="Master Admin — Kontenverwaltung (Direkter Datenbank-Zugriff)",
            bg=BG_CARD,
            fg=TEXT_MAIN,
            font=(ff, 11, "bold"),
        ).pack(side="left")

        env_switch = tk.Frame(acc_head, bg=BG_CARD)
        env_switch.pack(side="right")

        self.btn_env_prod = self._make_button(
            env_switch,
            "Production (Echtbetrieb)",
            lambda: self.switch_env("production"),
            kind="primary",
            padx=12,
            pady=4,
        )
        self.btn_env_prod.pack(side="left", padx=(0, 6))

        self.btn_env_play = self._make_button(
            env_switch,
            "Playground (Demo)",
            lambda: self.switch_env("playground"),
            kind="secondary",
            padx=12,
            pady=4,
        )
        self.btn_env_play.pack(side="left")

        # Optional first-run banner when Production has 0 accounts
        self.banner_frame = tk.Frame(
            acc_card,
            bg=BG_BANNER,
            padx=12,
            pady=8,
            highlightthickness=1,
            highlightbackground="#6b4e16",
        )
        self.banner_label = tk.Label(
            self.banner_frame,
            text="Noch kein Production-Admin vorhanden — bitte unten Benutzername & Passwort festlegen.",
            bg=BG_BANNER,
            fg=FG_BANNER,
            font=(ff, 9, "bold"),
            anchor="w",
        )
        self.banner_label.pack(fill="x")

        # 1-Row Create / Password Reset Form
        form_row = tk.Frame(acc_card, bg=BG_INPUT, padx=12, pady=10)
        form_row.pack(fill="x", pady=(0, 10))

        tk.Label(form_row, text="Benutzername:", bg=BG_INPUT, fg=TEXT_MUTED, font=(ff, 9)).pack(
            side="left", padx=(0, 6)
        )
        self.username_var = tk.StringVar()
        self.entry_username = tk.Entry(
            form_row,
            textvariable=self.username_var,
            bg=BG_MAIN,
            fg=TEXT_MAIN,
            insertbackground=TEXT_MAIN,
            relief="flat",
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
            highlightcolor=ACCENT,
            width=18,
            font=(ff, 10),
        )
        self.entry_username.pack(side="left", ipady=4, padx=(0, 12))

        tk.Label(form_row, text="Passwort:", bg=BG_INPUT, fg=TEXT_MUTED, font=(ff, 9)).pack(
            side="left", padx=(0, 6)
        )
        self.password_var = tk.StringVar()
        self.entry_password = tk.Entry(
            form_row,
            textvariable=self.password_var,
            bg=BG_MAIN,
            fg=TEXT_MAIN,
            insertbackground=TEXT_MAIN,
            relief="flat",
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
            highlightcolor=ACCENT,
            width=22,
            font=(ff, 10),
        )
        self.entry_password.pack(side="left", ipady=4, padx=(0, 6))

        self._make_button(
            form_row,
            "Vorschlag",
            self._on_suggest_password,
            padx=8,
            pady=4,
        ).pack(side="left", padx=(0, 12))

        tk.Label(form_row, text="Rolle:", bg=BG_INPUT, fg=TEXT_MUTED, font=(ff, 9)).pack(
            side="left", padx=(0, 6)
        )
        self.role_var = tk.StringVar(value="admin")
        self.combo_role = self.ttk.Combobox(
            form_row,
            textvariable=self.role_var,
            values=("admin", "staff", "worker"),
            state="readonly",
            width=10,
            font=(ff, 10),
        )
        self.combo_role.pack(side="left", padx=(0, 12))

        self._make_button(
            form_row,
            "Konto anlegen / Passwort speichern",
            self.on_save_account,
            kind="primary",
            padx=14,
            pady=5,
        ).pack(side="right")

        # Accounts Table (Treeview)
        table_frame = tk.Frame(acc_card, bg=BG_CARD)
        table_frame.pack(fill="both", expand=True, pady=(0, 10))

        cols = ("username", "role", "status", "sessions")
        self.tree = self.ttk.Treeview(
            table_frame,
            columns=cols,
            show="headings",
            selectmode="browse",
            height=6,
        )
        self.tree.heading("username", text="Benutzername", anchor="w")
        self.tree.heading("role", text="Rolle", anchor="w")
        self.tree.heading("status", text="Status", anchor="w")
        self.tree.heading("sessions", text="Sitzungen", anchor="w")

        self.tree.column("username", width=260, anchor="w")
        self.tree.column("role", width=150, anchor="w")
        self.tree.column("status", width=160, anchor="w")
        self.tree.column("sessions", width=120, anchor="w")

        scrollbar = self.ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)

        self.tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        self.tree.bind("<<TreeviewSelect>>", self._on_tree_select)

        # Quick action buttons below table
        actions_row = tk.Frame(acc_card, bg=BG_CARD)
        actions_row.pack(fill="x")

        tk.Label(
            actions_row,
            text="Ausgewähltes Konto:",
            bg=BG_CARD,
            fg=TEXT_MUTED,
            font=(ff, 9),
        ).pack(side="left", padx=(0, 10))

        self._make_button(
            actions_row,
            "Passwort setzen",
            self.on_quick_set_password,
            padx=10,
            pady=4,
        ).pack(side="left", padx=(0, 8))

        self._make_button(
            actions_row,
            "Entsperren & Aktivieren",
            self.on_quick_unlock_activate,
            padx=10,
            pady=4,
        ).pack(side="left", padx=(0, 8))

        self._make_button(
            actions_row,
            "Deaktivieren",
            self.on_quick_deactivate,
            kind="danger",
            padx=10,
            pady=4,
        ).pack(side="left", padx=(0, 8))

        self._make_button(
            actions_row,
            "Sitzungen abmelden",
            self.on_quick_logout_sessions,
            padx=10,
            pady=4,
        ).pack(side="left")

        # ── Status Bar at bottom ─────────────────────────────────────────────
        status_bar = tk.Frame(
            outer,
            bg=BG_CARD,
            padx=12,
            pady=8,
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
        )
        status_bar.pack(fill="x")

        self.status_label = tk.Label(
            status_bar,
            text="Bereit. Lokale Steuerung & Master Admin aktiv.",
            bg=BG_CARD,
            fg=TEXT_MAIN,
            font=(ff, 9),
            anchor="w",
        )
        self.status_label.pack(fill="x")

    # ── Status & LAN helpers ─────────────────────────────────────────────────

    def set_status(self, message: str, *, error: bool = False) -> None:
        self.status_label.configure(
            text=message,
            fg=ERR_RED if error else TEXT_MAIN,
        )

    def _update_lan_label(self) -> None:
        ips = local_lan_ips()
        if self.ctrl.host == "0.0.0.0" and ips:
            self.lan_label.configure(
                text=f"LAN: http://{ips[0]}:{launcher.PRODUCTION_PORT}",
                fg="#5eead4",
            )
        else:
            self.lan_label.configure(
                text="Lokal: 127.0.0.1",
                fg=TEXT_MUTED,
            )

    def _on_toggle_lan(self) -> None:
        allow_lan = bool(self.lan_var.get())
        new_host = "0.0.0.0" if allow_lan else "127.0.0.1"
        self.ctrl.host = new_host
        desktop.save_desktop_config(self.base_dir, default_mode="master", host=new_host)
        self._update_lan_label()
        if allow_lan:
            ips = local_lan_ips()
            ip_hint = f" (http://{ips[0]}:{launcher.PRODUCTION_PORT})" if ips else ""
            self.set_status(f"LAN-Freigabe aktiviert{ip_hint}. Gilt beim nächsten Serverstart.")
        else:
            self.set_status("LAN-Freigabe deaktiviert (nur lokal 127.0.0.1).")

    # ── Server Start / Stop / Status Poll ────────────────────────────────────

    def _apply_server_badges(self, prod_running: bool, play_running: bool) -> None:
        if self._closing:
            return
        if prod_running:
            self.badge_production.configure(text="● Läuft", fg=OK_GREEN)
            self.btn_stop_production.configure(state="normal")
        else:
            self.badge_production.configure(text="○ Gestoppt", fg=TEXT_MUTED)
            self.btn_stop_production.configure(state="disabled")

        if play_running:
            self.badge_playground.configure(text="● Läuft", fg=OK_GREEN)
            self.btn_stop_playground.configure(state="normal")
        else:
            self.badge_playground.configure(text="○ Gestoppt", fg=TEXT_MUTED)
            self.btn_stop_playground.configure(state="disabled")

    def _schedule_status_poll(self) -> None:
        if self._closing:
            return

        def _worker() -> None:
            prod = self.ctrl.is_running("production")
            play = self.ctrl.is_running("playground")
            if not self._closing:
                try:
                    self.root.after(0, lambda: self._apply_server_badges(prod, play))
                except Exception:  # noqa: BLE001
                    pass

        threading.Thread(target=_worker, name="gimel-gui-poll", daemon=True).start()
        self.root.after(3000, self._schedule_status_poll)

    def open_mode_url(self, mode: EnvName, path: str) -> None:
        label = "Production" if mode == "production" else "Playground"
        port = launcher.PRODUCTION_PORT if mode == "production" else launcher.PLAYGROUND_PORT
        self.set_status(f"Starte {label} auf Port {port}…")

        def _worker() -> None:
            try:
                base_url = self.ctrl.start_mode(mode)
                full_url = f"{base_url}{path}"
                self.ctrl.open_url_window(full_url)
                prod = self.ctrl.is_running("production")
                play = self.ctrl.is_running("playground")
                self.root.after(
                    0,
                    lambda: (
                        self._apply_server_badges(prod, play),
                        self.set_status(f"{label} läuft auf Port {port} ({full_url} geöffnet)."),
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                msg = str(exc)
                self.root.after(0, lambda: self.set_status(msg, error=True))

        threading.Thread(target=_worker, name=f"gimel-start-{mode}", daemon=True).start()

    def stop_server(self, mode: EnvName) -> None:
        label = "Production" if mode == "production" else "Playground"
        self.set_status(f"Stoppe {label}…")

        def _worker() -> None:
            self.ctrl.stop_mode(mode)
            prod = self.ctrl.is_running("production")
            play = self.ctrl.is_running("playground")
            self.root.after(
                0,
                lambda: (
                    self._apply_server_badges(prod, play),
                    self.set_status(f"{label} wurde gestoppt."),
                ),
            )

        threading.Thread(target=_worker, name=f"gimel-stop-{mode}", daemon=True).start()

    # ── Master Admin Accounts ────────────────────────────────────────────────

    def switch_env(self, env: EnvName) -> None:
        self.current_env = env
        if env == "production":
            self.btn_env_prod.configure(bg=ACCENT, fg="#ffffff", activebackground=ACCENT_HOVER)
            self.btn_env_play.configure(bg=BG_INPUT, fg=TEXT_MAIN, activebackground="#283240")
        else:
            self.btn_env_play.configure(bg=ACCENT, fg="#ffffff", activebackground=ACCENT_HOVER)
            self.btn_env_prod.configure(bg=BG_INPUT, fg=TEXT_MAIN, activebackground="#283240")
        self.refresh_accounts()

    def _on_suggest_password(self) -> None:
        self.password_var.set(generate_password_suggestion())

    def refresh_accounts(self, *, initial: bool = False) -> None:
        try:
            self.accounts = master_admin.list_accounts(self.base_dir, self.current_env)
        except Exception as exc:  # noqa: BLE001
            self.set_status(f"Fehler beim Laden der Konten: {exc}", error=True)
            self.accounts = []

        # Show banner & prefill if Production has 0 accounts
        if self.current_env == "production" and len(self.accounts) == 0:
            self.banner_frame.pack(fill="x", pady=(0, 10), before=self.entry_username.master)
            if initial or not self._prefilled_initial_admin:
                self._prefilled_initial_admin = True
                if not self.username_var.get().strip():
                    self.username_var.set("admin")
                if not self.password_var.get():
                    self.password_var.set(generate_password_suggestion())
                self.role_var.set("admin")
        else:
            self.banner_frame.pack_forget()

        for item in self.tree.get_children():
            self.tree.delete(item)
        self._account_by_iid.clear()

        for acc in self.accounts:
            iid = str(acc["id"])
            self._account_by_iid[iid] = acc
            if not acc.get("active"):
                st = "Deaktiviert"
            elif acc.get("locked"):
                st = "Gesperrt"
            else:
                st = "Aktiv"
            self.tree.insert(
                "",
                "end",
                iid=iid,
                values=(
                    acc["username"],
                    acc["role"],
                    st,
                    str(acc.get("active_sessions", 0)),
                ),
            )

    def _on_tree_select(self, _event=None) -> None:
        acc = self._selected_account()
        if not acc:
            return
        self.username_var.set(acc["username"])
        self.role_var.set(acc["role"])

    def _selected_account(self) -> dict | None:
        sel = self.tree.selection()
        if not sel:
            return None
        return self._account_by_iid.get(sel[0])

    def on_save_account(self) -> None:
        uname = self.username_var.get().strip().lower()
        pw = self.password_var.get()
        role = self.role_var.get().strip() or "admin"
        try:
            acc = master_admin.upsert_account(
                self.base_dir,
                self.current_env,
                username=uname,
                password=pw,
                role=role,
            )
            env_label = "Production" if self.current_env == "production" else "Playground"
            self.password_var.set("")
            self.refresh_accounts()
            self.set_status(
                f"Konto '{acc['username']}' ({acc['role']}) in {env_label} gespeichert & entsperrt."
            )
        except Exception as exc:  # noqa: BLE001
            self.set_status(str(exc), error=True)

    def on_quick_set_password(self) -> None:
        acc = self._selected_account()
        if not acc:
            self.set_status("Bitte zuerst ein Konto in der Tabelle auswählen.", error=True)
            return
        pw = self.password_var.get()
        if not pw:
            from tkinter import simpledialog

            pw = simpledialog.askstring(
                "Passwort setzen",
                f"Neues Passwort für '{acc['username']}' (mind. 8 Zeichen):",
                initialvalue=generate_password_suggestion(),
                parent=self.root,
            ) or ""
        if not pw:
            return
        try:
            master_admin.update_account(
                self.base_dir,
                self.current_env,
                int(acc["id"]),
                password=pw,
                unlock=True,
            )
            self.password_var.set("")
            self.refresh_accounts()
            self.set_status(f"Neues Passwort für '{acc['username']}' gespeichert & Konto entsperrt.")
        except Exception as exc:  # noqa: BLE001
            self.set_status(str(exc), error=True)

    def on_quick_unlock_activate(self) -> None:
        acc = self._selected_account()
        if not acc:
            self.set_status("Bitte zuerst ein Konto in der Tabelle auswählen.", error=True)
            return
        try:
            master_admin.update_account(
                self.base_dir,
                self.current_env,
                int(acc["id"]),
                active=True,
                unlock=True,
            )
            self.refresh_accounts()
            self.set_status(f"Konto '{acc['username']}' entsperrt & aktiviert.")
        except Exception as exc:  # noqa: BLE001
            self.set_status(str(exc), error=True)

    def on_quick_deactivate(self) -> None:
        acc = self._selected_account()
        if not acc:
            self.set_status("Bitte zuerst ein Konto in der Tabelle auswählen.", error=True)
            return
        try:
            master_admin.update_account(
                self.base_dir,
                self.current_env,
                int(acc["id"]),
                active=False,
            )
            self.refresh_accounts()
            self.set_status(f"Konto '{acc['username']}' deaktiviert & Sitzungen beendet.")
        except Exception as exc:  # noqa: BLE001
            self.set_status(str(exc), error=True)

    def on_quick_logout_sessions(self) -> None:
        acc = self._selected_account()
        if not acc:
            self.set_status("Bitte zuerst ein Konto in der Tabelle auswählen.", error=True)
            return
        try:
            master_admin.update_account(
                self.base_dir,
                self.current_env,
                int(acc["id"]),
                logout_all=True,
            )
            self.refresh_accounts()
            self.set_status(f"Alle aktiven Sitzungen für '{acc['username']}' abgemeldet.")
        except Exception as exc:  # noqa: BLE001
            self.set_status(str(exc), error=True)

    def on_close(self) -> None:
        self._closing = True
        try:
            self.ctrl.shutdown_all()
        except Exception:  # noqa: BLE001
            pass
        self.root.destroy()


def run_native_desktop_gui(
    base_dir: Path,
    *,
    host: str = launcher.DEFAULT_HOST,
    initial_view: str = "master",
) -> int:
    """Launch the native tkinter/ttk Master Admin & Desktop Control Center."""
    import tkinter as tk

    _enable_windows_dpi_awareness()
    root = tk.Tk()
    GimelDesktopApp(root, base_dir=base_dir, host=host, initial_view=initial_view)
    root.mainloop()
    return 0
