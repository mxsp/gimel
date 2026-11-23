# Third-Party Licenses

Gimel builds on the following major open-source libraries. Full license texts are installed alongside each package in your Python/Node environment.

## Python Dependencies
- **FastAPI** — MIT License
- **Starlette / Uvicorn** — BSD-3-Clause License
- **SQLAlchemy** — MIT License
- **Pydantic / pydantic-settings** — MIT License
- **PyJWT / email-validator / ezdxf / stripe** — MIT License
- **bcrypt / cryptography** — Apache-2.0 / BSD-3-Clause
- **NumPy / pypdf** — BSD-3-Clause License
- **psycopg** *(Docker production image)* — LGPL-3.0

### Optional Extras (Not Included by Default)
- **voice extra (`piper-tts`)** — **GPL-3.0**. Not installed in default builds, containers, or executables. If you opt in to `[voice]` and redistribute binaries, comply with GPL-3.0 terms.
- **vision extra (`opencv-python-headless`)** — Apache-2.0 License.

## Frontend Dependencies
- **React / ReactDOM** — MIT License
- **BlueprintJS (`@blueprintjs/core`, `icons`, `select`)** — Apache-2.0 License
- **Three.js** — MIT License
- **Vite** — MIT License
- **@mediapipe/tasks-vision** — Apache-2.0 License (runtime WASM/models are not committed to this repository)
