# Gimel API — every route of the current code

Generated 2026-11-16 from the running demo (`http://127.0.0.1:8040/openapi.json`, local Gimel `main` @ cb5cdc52, v0.2.0).
The machine-readable contract is `openapi.json` in this folder; request and response schemas are there.

**357 operations; 72 of them are missing from `GIMEL.md`** (which was built from the old `mxsp-all` tree with 285). They are marked **NEW**.
The server only exposes `/api/agent/*` when `GET /api/version` reports `agent: true`; `agent-voice` only where voice is switched on.

| Tag | Routes | New |
|---|---|---|
| [agent-voice](#agent-voice) | 2 | 2 |
| [auth](#auth) | 11 | 2 |
| [account](#account) | 26 | 5 |
| [users](#users) | 9 | 0 |
| [products](#products) | 11 | 0 |
| [rates](#rates) | 4 | 0 |
| [quotes](#quotes) | 4 | 0 |
| [production](#production) | 28 | 0 |
| [nesting](#nesting) | 5 | 0 |
| [punchout](#punchout) | 5 | 0 |
| [admin](#admin) | 15 | 0 |
| [shipping](#shipping) | 10 | 0 |
| [links](#links) | 1 | 1 |
| [inventory](#inventory) | 7 | 4 |
| [integration](#integration) | 4 | 0 |
| [customers](#customers) | 12 | 1 |
| [desk](#desk) | 12 | 5 |
| [invoicing](#invoicing) | 20 | 0 |
| [factory](#factory) | 72 | 14 |
| [robots](#robots) | 26 | 1 |
| [drawings](#drawings) | 7 | 0 |
| [free-nesting](#free-nesting) | 4 | 0 |
| [compliance](#compliance) | 10 | 0 |
| [vision](#vision) | 13 | 0 |
| [agent](#agent) | 37 | 37 |
| [meta](#meta) | 2 | 0 |

## agent-voice

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
| **NEW** | GET | `/api/agent/voice` | Voice Info |  |  |
| **NEW** | POST | `/api/agent/transcribe` | Transcribe Audio |  | `language` |

## auth

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | POST | `/api/auth/register` | Register | `RegisterRequest` |  |
|  | POST | `/api/auth/login` | Login | `Body_login_api_auth_login_post` |  |
| **NEW** | POST | `/api/auth/reset/request` | Reset Request | `PasswordResetRequest` |  |
| **NEW** | POST | `/api/auth/reset/confirm` | Reset Confirm | `PasswordResetConfirm` |  |
|  | POST | `/api/auth/2fa` | Login Second Factor | `MfaLogin` |  |
|  | POST | `/api/auth/refresh` | Refresh |  |  |
|  | POST | `/api/auth/logout` | Logout |  |  |
|  | GET | `/api/auth/login-options` | Login Options |  |  |
|  | POST | `/api/auth/pin` | Pin Login | `PinLogin` |  |
|  | GET | `/api/auth/me` | Me |  |  |
|  | POST | `/api/auth/password` | Change Password | `PasswordChange` |  |

## account

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/account/me` | Get Me |  |  |
|  | DELETE | `/api/account/me` | Delete Me | `MfaDisable` |  |
|  | PATCH | `/api/account/me` | Update Me | `AccountUpdate` |  |
|  | GET | `/api/account/security` | Security Overview |  |  |
|  | POST | `/api/account/2fa/start` | Mfa Start | `MfaStart` |  |
|  | POST | `/api/account/2fa/enable` | Mfa Enable | `MfaConfirm` |  |
|  | POST | `/api/account/2fa/disable` | Mfa Off | `MfaDisable` |  |
|  | POST | `/api/account/2fa/recovery` | Mfa New Recovery | `MfaDisable` |  |
|  | POST | `/api/account/email` | Change Email | `EmailChange` |  |
|  | DELETE | `/api/account/sessions/{session_id}` | Revoke Session |  |  |
|  | POST | `/api/account/sessions/revoke-others` | Revoke Other Sessions |  |  |
|  | GET | `/api/account/addresses` | List Addresses |  |  |
|  | POST | `/api/account/addresses` | Create Address | `gimel__routers__account__AddressIn` |  |
|  | PUT | `/api/account/addresses/{addr_id}` | Update Address | `gimel__routers__account__AddressIn` |  |
|  | DELETE | `/api/account/addresses/{addr_id}` | Delete Address |  |  |
| **NEW** | GET | `/api/account/parts` | List Parts |  |  |
| **NEW** | POST | `/api/account/parts` | Create Part | `gimel__schemas__PartIn` |  |
| **NEW** | GET | `/api/account/parts/{part_id}` | Get Part |  |  |
| **NEW** | PATCH | `/api/account/parts/{part_id}` | Update Part | `PartPatch` |  |
| **NEW** | DELETE | `/api/account/parts/{part_id}` | Delete Part |  |  |
|  | GET | `/api/account/orders/{no}/tracking` | My Order Tracking |  |  |
|  | GET | `/api/account/orders/{no}/invoice.xml` | My Invoice Xml |  |  |
|  | GET | `/api/account/orders` | My Orders |  |  |
|  | POST | `/api/account/claim` | Claim Orders | `ClaimRequest` |  |
|  | POST | `/api/account/email-verification/request` | Request Email Verification |  |  |
|  | POST | `/api/account/email-verification/confirm` | Confirm Email Verification | `EmailVerification` |  |

## users

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/users` | List Users |  | `q`, `role`, `active`, `limit`, `offset` |
|  | POST | `/api/users` | Create User | `UserCreate` |  |
|  | GET | `/api/users/customers` | List Customers |  | `q`, `role`, `limit` |
|  | PATCH | `/api/users/{user_id}` | Update User | `UserUpdate` |  |
|  | DELETE | `/api/users/{user_id}` | Delete User |  |  |
|  | POST | `/api/users/{user_id}/password` | Set Password | `PasswordSet` |  |
|  | POST | `/api/users/{user_id}/unlock` | Unlock User |  |  |
|  | POST | `/api/users/{user_id}/mfa/reset` | Reset Mfa |  |  |
|  | GET | `/api/users/{user_id}/orders` | Customer Orders |  |  |

## products

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/products` | List Products |  | `q`, `cat`, `cnc`, `plotter_only`, `include_inactive`, `limit` |
|  | POST | `/api/products` | Create Product | `ProductCreate` |  |
|  | GET | `/api/products/{product_id}` | Get Product |  |  |
|  | PATCH | `/api/products/{product_id}` | Update Product | `ProductUpdate` |  |
|  | DELETE | `/api/products/{product_id}` | Deactivate Product |  |  |
|  | GET | `/api/products/{product_id}/price-history` | Price History |  |  |
|  | POST | `/api/products/plotter-only/apply` | Apply Plotter Only |  |  |
|  | GET | `/api/products/plotter-only/preview` | Plotter Only Preview |  |  |
|  | POST | `/api/products/prices/bulk` | Bulk Price | `BulkPriceChange` |  |
|  | GET | `/api/products/matrix/view` | Matrix |  | `include_inactive` |
|  | POST | `/api/products/matrix/save` | Save Matrix | `MatrixSave` |  |

## rates

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/rates` | List Rates |  |  |
|  | PATCH | `/api/rates/{key}` | Update Rate | `RateUpdate` |  |
|  | GET | `/api/rates/{key}/history` | Rate History |  | `limit` |
|  | GET | `/api/rates/engine/keys` | Engine Keys |  |  |

## quotes

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | POST | `/api/quote` | Calculate | `QuoteRequest` |  |
|  | POST | `/api/orders` | Create Order | `OrderRequest` |  |
|  | GET | `/api/orders/{no}` | Get Order |  |  |
|  | POST | `/api/orders/{no}/reorder` | Reorder |  |  |

## production

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/production/queue` | Queue |  |  |
|  | GET | `/api/production/queue/bucket` | Queue Bucket |  | `mat`, `thk`, `customer_id` |
|  | GET | `/api/production/queue/bucket/plate/{idx}.svg` | Queue Bucket Plate |  | `mat`, `thk`, `customer_id` |
|  | GET | `/api/production/runs` | List Runs |  | `limit` |
|  | POST | `/api/production/runs` | Trigger Run |  | `force` |
|  | POST | `/api/production/runs/start` | Start Run | `application/json` | `force` |
|  | GET | `/api/production/runs/jobs/{job_id}` | Run Job |  |  |
|  | POST | `/api/production/renest` | Renest | `RenestIn` |  |
|  | POST | `/api/production/orders/{no}/release` | Release Order | `gimel__routers__production__ReleaseIn` |  |
|  | GET | `/api/production/orders/{no}` | Order For Production |  |  |
|  | POST | `/api/production/policies/preview` | Preview Policy | `PolicyIn` |  |
|  | GET | `/api/production/policies` | List Policies |  |  |
|  | PUT | `/api/production/policies` | Upsert Policy | `PolicyIn` |  |
|  | DELETE | `/api/production/policies/{policy_id}` | Delete Policy |  |  |
|  | GET | `/api/production/work-orders` | List Work Orders |  | `status`, `run`, `limit` |
|  | GET | `/api/production/work-orders/{no}` | Get Work Order |  |  |
|  | POST | `/api/production/work-orders/{no}/plates/{idx}/status` | Set Plate Status | `PlateStatusIn` |  |
|  | PATCH | `/api/production/work-orders/{no}/plates/{idx}/status` | Set Plate Status And Finish | `PlateStatusChange` |  |
|  | GET | `/api/production/work-orders/{no}/plate/{idx}.svg` | Plate Drawing |  | `width`, `download` |
|  | GET | `/api/production/work-orders/{no}/part/{position_id}.svg` | Part Drawing |  | `width`, `download` |
|  | GET | `/api/production/work-orders/{no}/plate/{idx}.dxf` | Plate Cutfile |  | `plotpro`, `strategy` |
|  | GET | `/api/production/work-orders/{no}/plate/{idx}/auftrag/{order_no}.dxf` | Plate Cutfile For Order |  |  |
|  | GET | `/api/production/work-orders/{no}/part/{position_id}.dxf` | Part Cutfile |  |  |
|  | GET | `/api/production/work-orders/{no}/cutfiles.zip` | Cutfile Bundle |  | `plotpro`, `strategy` |
|  | GET | `/api/production/work-orders/{no}/sheet` | Traveller |  | `download` |
|  | POST | `/api/production/work-orders/{no}/status` | Set Status | `StatusChange` |  |
|  | POST | `/api/production/work-orders/{no}/stage` | Set Material Staged | `StageChange` |  |
|  | POST | `/api/production/work-orders/{no}/orders/{order_no}/done` | Toggle Order Done | `OrderDoneToggle` |  |

## nesting

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/production/work-orders/{no}/layout` | Get Layout |  |  |
|  | PUT | `/api/production/work-orders/{no}/layout` | Save Layout | `SaveIn` |  |
|  | POST | `/api/production/work-orders/{no}/layout/check` | Check Layout | `LayoutIn` |  |
|  | POST | `/api/production/work-orders/{no}/layout/auto` | Auto Layout |  |  |
|  | POST | `/api/production/work-orders/{no}/layout/reset` | Reset Layout | `ResetIn` |  |

## punchout

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | POST | `/api/punchout/setup` | Setup |  |  |
|  | GET | `/api/punchout/session/{token}` | Session Info |  |  |
|  | POST | `/api/punchout/cart` | Cart Return | `CartIn` |  |
|  | GET | `/api/punchout/cart/form` | Cart Form |  | `token` |
|  | GET | `/api/punchout/sessions` | List Sessions |  | `open_only` |

## admin

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | POST | `/api/admin/events/ticket` | Sse Ticket |  |  |
|  | GET | `/api/admin/events` | Sse Events |  | `ticket` |
|  | GET | `/api/admin/settings` | List Settings |  |  |
|  | PUT | `/api/admin/settings/{key}` | Set Setting | `gimel__routers__admin__SettingIn` |  |
|  | GET | `/api/admin/audit` | Audit |  | `action`, `actor`, `entity`, `entity_id`, `since`, `until`, `before_id`, `limit` |
|  | GET | `/api/admin/audit/actions` | Audit Actions |  |  |
|  | GET | `/api/admin/stats` | Stats |  |  |
|  | GET | `/api/admin/dimension-limits` | Get Dimension Limits |  |  |
|  | GET | `/api/admin/orders` | List Orders |  | `q`, `status`, `limit`, `offset` |
|  | GET | `/api/admin/orders/{no}` | Order Detail |  |  |
|  | POST | `/api/admin/orders/{no}/clone` | Clone Order |  |  |
|  | POST | `/api/admin/orders/{no}/paid` | Mark Paid | `MarkPaidIn` |  |
|  | GET | `/api/admin/orders/{no}/timeline` | Order Timeline |  |  |
|  | POST | `/api/admin/orders/{no}/rollback` | Order Rollback | `RollbackIn` |  |
|  | POST | `/api/admin/orders/{no}/rollback_legacy` | Order Rollback Legacy | `RollbackIn` |  |

## shipping

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/shipping/ready` | Ready Orders |  |  |
|  | GET | `/api/shipping/` | List Shipments |  | `status` |
|  | POST | `/api/shipping/` | Create Shipment | `ShipmentCreate` |  |
|  | GET | `/api/shipping/{no}` | Get Shipment |  |  |
|  | PATCH | `/api/shipping/{no}` | Update Shipment | `ShipmentUpdate` |  |
|  | DELETE | `/api/shipping/{no}` | Delete Shipment |  |  |
|  | GET | `/api/shipping/{no}/label` | Shipment Label Html |  |  |
|  | GET | `/api/shipping/{no}/orders` | Shipment Orders |  |  |
|  | GET | `/api/shipping/by-order/{order_no}` | Shipments By Order |  |  |
|  | GET | `/api/shipping/{no}/tracking` | Shipment Tracking |  |  |

## links

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
| **NEW** | GET | `/api/links/{no}` | Related |  |  |

## inventory

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/inventory` | List Stock |  | `include_inactive` |
| **NEW** | GET | `/api/inventory/offcuts` | List Offcuts |  | `mat`, `status`, `limit` |
| **NEW** | POST | `/api/inventory/offcuts` | Create Offcut | `OffcutIn` |  |
| **NEW** | PATCH | `/api/inventory/offcuts/{offcut_id}` | Update Offcut | `OffcutPatch` |  |
|  | GET | `/api/inventory/{product_id}/movements` | Stock Movements |  | `limit` |
| **NEW** | GET | `/api/inventory/{product_id}/timeline` | Stock Timeline |  | `days` |
|  | POST | `/api/inventory/{product_id}/adjust` | Adjust Stock | `StockAdjust` |  |

## integration

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/integration/health` | Health |  |  |
|  | GET | `/api/integration/stock` | Stock |  | `mats` |
|  | GET | `/api/integration/plates` | Plates |  | `mats` |
|  | POST | `/api/integration/sync` | Sync | `SyncIn` |  |

## customers

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/customers` | List Customers |  | `q`, `limit`, `include_removed` |
|  | POST | `/api/customers` | Create Customer | `CustomerCreate` |  |
|  | GET | `/api/customers/next-number` | Peek Customer No |  |  |
| **NEW** | GET | `/api/customers/duplicates` | Find Duplicates |  | `email`, `company`, `vat_id`, `exclude_id` |
|  | GET | `/api/customers/{customer_id}` | Get Customer |  |  |
|  | PATCH | `/api/customers/{customer_id}` | Update Customer | `CustomerUpdate` |  |
|  | DELETE | `/api/customers/{customer_id}` | Delete Customer |  |  |
|  | GET | `/api/customers/{customer_id}/addresses` | List Addresses |  |  |
|  | POST | `/api/customers/{customer_id}/addresses` | Add Address | `gimel__routers__customers__AddressIn` |  |
|  | PUT | `/api/customers/{customer_id}/addresses/{address_id}` | Update Address | `gimel__routers__customers__AddressIn` |  |
|  | DELETE | `/api/customers/{customer_id}/addresses/{address_id}` | Delete Address |  |  |
|  | GET | `/api/customers/{customer_id}/orders` | Customer Orders |  |  |

## desk

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | POST | `/api/desk/dxf` | Upload Dxf | `Body_upload_dxf_api_desk_dxf_post` |  |
|  | POST | `/api/desk/import/orders` | Import Orders | `Body_import_orders_api_desk_import_orders_post` | `commit` |
|  | GET | `/api/desk/export/orders.csv` | Export Orders |  |  |
|  | POST | `/api/desk/orders` | Create Order | `DeskOrderIn` |  |
|  | GET | `/api/desk/orders` | List Orders |  | `q`, `limit` |
|  | GET | `/api/desk/orders/{no}` | Get Order |  |  |
| **NEW** | PATCH | `/api/desk/orders/{no}` | Change Order | `OrderChangeIn` |  |
|  | POST | `/api/desk/orders/{no}/release` | Release Order | `gimel__routers__desk__ReleaseIn` |  |
| **NEW** | POST | `/api/desk/orders/{no}/hold` | Hold Order | `HoldIn` |  |
| **NEW** | POST | `/api/desk/orders/{no}/resume` | Resume Order | `ResumeIn` |  |
| **NEW** | GET | `/api/desk/orders/{no}/cancel-check` | Cancel Check |  |  |
| **NEW** | POST | `/api/desk/orders/{no}/cancel` | Cancel Order | `gimel__routers__desk__CancelIn` |  |

## invoicing

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/invoicing/orders/{no}/billing-check` | Billing Check |  |  |
|  | GET | `/api/invoicing/orders/{no}/invoice.xml` | Invoice Xml |  |  |
|  | GET | `/api/invoicing/config` | Config |  |  |
|  | GET | `/api/invoicing/seller` | Get Seller |  |  |
|  | PUT | `/api/invoicing/seller` | Put Seller | `SellerIn` |  |
|  | POST | `/api/invoicing/orders/{no}/invoice/cancel` | Cancel Local Invoice | `gimel__routers__invoicing__CancelIn` |  |
|  | GET | `/api/invoicing/export/invoices.csv` | Export Invoices |  |  |
|  | GET | `/api/invoicing/local` | List Local |  |  |
|  | GET | `/api/invoicing/local/{number}/invoice.html` | Local Html |  |  |
|  | GET | `/api/invoicing/local/{number}/invoice.xml` | Local Xml |  |  |
|  | GET | `/api/invoicing/orders/{no}/invoice.html` | Order Invoice Html |  |  |
|  | POST | `/api/invoicing/orders/{no}/invoice` | Create Invoice | `InvoiceIn` |  |
|  | POST | `/api/invoicing/orders/{no}/invoice/sync` | Sync Invoice |  |  |
|  | GET | `/api/invoicing/invoices` | List Invoices |  | `only_open`, `limit` |
|  | GET | `/api/invoicing/orders/{no}/invoice.pdf` | Invoice Pdf |  | `refresh` |
|  | GET | `/api/invoicing/orders/{no}/invoice/links` | Invoice Links |  |  |
|  | POST | `/api/invoicing/orders/{no}/invoice/send` | Resend Invoice |  |  |
|  | POST | `/api/invoicing/orders/{no}/invoice/void` | Void Invoice |  |  |
|  | POST | `/api/invoicing/orders/{no}/invoice/paid` | Mark Paid | `ManualPayment` |  |
|  | POST | `/api/invoicing/invoices/sync-open` | Sync All Open |  |  |

## factory

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/factory/floor` | Get Floor |  | `floor_id` |
|  | PUT | `/api/factory/floor` | Put Floor | `FloorIn` | `floor_id` |
|  | GET | `/api/factory/route` | Route Between |  | `from_id`, `to_id` |
|  | GET | `/api/factory/stations` | List Stations |  |  |
|  | POST | `/api/factory/stations` | Create Station | `StationIn` |  |
|  | PUT | `/api/factory/stations/{sid}` | Update Station | `StationIn` |  |
|  | DELETE | `/api/factory/stations/{sid}` | Delete Station |  |  |
|  | POST | `/api/factory/stations/{sid}/model` | Upload Station Model | `Body_upload_station_model_api_factory_stations__sid__model_post` |  |
|  | GET | `/api/factory/stations/{sid}/model` | Get Station Model |  |  |
|  | DELETE | `/api/factory/stations/{sid}/model` | Delete Station Model |  |  |
|  | GET | `/api/factory/settings` | List Settings |  |  |
|  | GET | `/api/factory/settings/{key}` | Get Setting |  |  |
|  | PUT | `/api/factory/settings/{key}` | Put Setting | `gimel__routers__factory__SettingIn` |  |
|  | GET | `/api/factory/stations/{sid}/view` | Station View |  |  |
|  | GET | `/api/factory/work-orders/{no}/ranking` | Work Order Ranking |  |  |
|  | POST | `/api/factory/routing/simulate` | Simulate Routing | `SimulateIn` |  |
|  | POST | `/api/factory/work-orders/{no}/assign` | Assign Work Order | `gimel__routers__factory__AssignIn` |  |
|  | GET | `/api/factory/plan` | Get Plan |  | `limit`, `include_assigned` |
|  | POST | `/api/factory/plan/apply` | Apply Plan Endpoint | `ApplyIn` |  |
|  | POST | `/api/factory/plan/feed` | Feed Empty Stations |  |  |
|  | GET | `/api/factory/stations/{sid}/queue` | Station Queue |  |  |
|  | GET | `/api/factory/orders/{order_no}/handlers` | Order Handlers |  |  |
|  | POST | `/api/factory/orders/{order_no}/handler` | Set Order Handler | `HandlerIn` |  |
|  | GET | `/api/factory/handlers/plan` | Handler Plan |  | `limit` |
|  | GET | `/api/factory/flow` | Flow |  |  |
|  | POST | `/api/factory/stations/{sid}/complete/{order_no}` | Mark Completed |  |  |
|  | GET | `/api/factory/orders/ranking/{order_no}` | Order Ranking Legacy |  |  |
|  | GET | `/api/factory/pipeline` | Pipeline |  | `limit` |
|  | GET | `/api/factory/staging` | Staging |  | `limit` |
|  | GET | `/api/factory/twin/analysis` | Twin Analysis |  |  |
|  | POST | `/api/factory/floor/outline/from-dxf` | Outline From Dxf | `Body_outline_from_dxf_api_factory_floor_outline_from_dxf_post` | `unit`, `target_w_m` |
|  | GET | `/api/factory/worklist` | Get Worklist |  | `kind` |
|  | POST | `/api/factory/worklist/reconcile` | Run Worklist Reconcile |  |  |
|  | GET | `/api/factory/stations/{sid}/worklist` | Get Station Worklist |  |  |
|  | GET | `/api/factory/worklist/plan` | Get Worklist Plan |  | `kind` |
|  | POST | `/api/factory/worklist/apply` | Apply Worklist Plan | `WorklistApplyIn` |  |
|  | POST | `/api/factory/tasks/{task_id}/assign` | Assign Task | `TaskAssignIn` |  |
|  | POST | `/api/factory/tasks/{task_id}/state` | Set Task State | `TaskStateIn` |  |
|  | POST | `/api/factory/stations/{sid}/worklist/order` | Reorder Worklist | `ReorderIn` |  |
|  | DELETE | `/api/factory/stations/{sid}/worklist/order` | Free Worklist Order |  |  |
|  | GET | `/api/factory/picking` | Picking Board |  |  |
| **NEW** | GET | `/api/factory/stock-locations` | List Stock Locations |  | `mat` |
| **NEW** | POST | `/api/factory/stock-locations` | Create Stock Location | `StockLocationIn` |  |
| **NEW** | PUT | `/api/factory/stock-locations/{loc_id}` | Update Stock Location | `StockLocationIn` |  |
| **NEW** | DELETE | `/api/factory/stock-locations/{loc_id}` | Delete Stock Location |  |  |
|  | GET | `/api/factory/topology` | Topology |  |  |
|  | POST | `/api/factory/sites` | Create Site | `SiteIn` |  |
|  | PUT | `/api/factory/sites/{site_id}` | Update Site | `SiteIn` |  |
|  | DELETE | `/api/factory/sites/{site_id}` | Delete Site |  |  |
|  | POST | `/api/factory/halls` | Create Hall | `HallIn` |  |
|  | PUT | `/api/factory/halls/{hall_id}` | Update Hall | `HallIn` |  |
|  | DELETE | `/api/factory/halls/{hall_id}` | Delete Hall |  |  |
|  | POST | `/api/factory/floors` | Create Level | `LevelIn` |  |
|  | DELETE | `/api/factory/floors/{floor_id}` | Delete Level |  |  |
|  | GET | `/api/factory/orders/{order_no}/scope` | Get Order Scope |  |  |
|  | PUT | `/api/factory/orders/{order_no}/scope` | Set Order Scope | `ScopeIn` |  |
|  | PUT | `/api/factory/work-orders/{no}/scope` | Set Work Order Scope | `ScopeIn` |  |
| **NEW** | GET | `/api/factory/views` | List Views |  | `floor_id` |
| **NEW** | POST | `/api/factory/views` | Create View | `TwinViewIn` |  |
| **NEW** | DELETE | `/api/factory/views/{view_id}` | Delete View |  |  |
| **NEW** | GET | `/api/factory/fleet-sim/defaults` | Fleet Sim Defaults |  | `floor_id` |
| **NEW** | POST | `/api/factory/fleet-sim/run` | Fleet Sim Run | `FleetSimIn` |  |
| **NEW** | GET | `/api/factory/fleet-sim/scenarios` | List Fleet Scenarios |  | `floor_id` |
| **NEW** | POST | `/api/factory/fleet-sim/scenarios` | Create Fleet Scenario | `FleetScenarioIn` |  |
| **NEW** | DELETE | `/api/factory/fleet-sim/scenarios/{scenario_id}` | Delete Fleet Scenario |  |  |
|  | GET | `/api/factory/robots` | List Robots |  | `floor_id` |
|  | POST | `/api/factory/robots` | Create Robot | `RobotIn` |  |
| **NEW** | GET | `/api/factory/robots/route-check` | Route Check |  | `floor_id` |
| **NEW** | POST | `/api/factory/robots/{robot_id}/improve-route` | Improve Route | `ImproveIn` |  |
|  | GET | `/api/factory/robots/{robot_id}` | Get Robot |  |  |
|  | PUT | `/api/factory/robots/{robot_id}` | Update Robot | `RobotIn` |  |
|  | DELETE | `/api/factory/robots/{robot_id}` | Delete Robot |  |  |

## robots

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/factory/robot-gateways` | List Gateways |  |  |
|  | POST | `/api/factory/robot-gateways` | Create Gateway | `GatewayIn` |  |
|  | PUT | `/api/factory/robot-gateways/{gateway_id}` | Update Gateway | `GatewayIn` |  |
|  | DELETE | `/api/factory/robot-gateways/{gateway_id}` | Delete Gateway |  |  |
|  | POST | `/api/factory/robot-gateways/{gateway_id}/test` | Test Gateway |  |  |
|  | GET | `/api/factory/robot-programs` | List Programs |  | `status`, `limit` |
|  | POST | `/api/factory/robot-programs` | Create Program | `ProgramIn` |  |
|  | POST | `/api/factory/robot-programs/{program_id}/approve` | Approve Program |  |  |
|  | POST | `/api/factory/robot-programs/{program_id}/deploy` | Deploy Program | `DeployIn` |  |
|  | GET | `/api/factory/robot-deployments` | List Deployments |  | `limit` |
|  | POST | `/api/factory/robot-deployments/{deployment_id}/rollback` | Rollback Deployment |  |  |
|  | GET | `/api/factory/robot-jobs` | List Jobs |  | `state`, `active`, `floor_id`, `order_no`, `work_order_no` |
|  | POST | `/api/factory/robot-jobs` | Create Job | `JobIn` |  |
|  | POST | `/api/factory/robot-jobs/plan` | Plan Job | `JobIn` |  |
|  | GET | `/api/factory/robot-jobs/{job_id}` | Get Job |  |  |
|  | POST | `/api/factory/robot-jobs/{job_id}/approve` | Approve Job |  |  |
|  | POST | `/api/factory/robot-jobs/{job_id}/assign` | Assign Job | `gimel__routers__robot_job_routes__AssignIn` |  |
|  | POST | `/api/factory/robot-jobs/{job_id}/start` | Start Job |  |  |
|  | POST | `/api/factory/robot-jobs/{job_id}/done` | Done Job | `NoteIn` |  |
|  | POST | `/api/factory/robot-jobs/{job_id}/cancel` | Cancel Job | `NoteIn` |  |
|  | POST | `/api/factory/robot-jobs/{job_id}/fail` | Fail Job | `NoteIn` |  |
|  | POST | `/api/factory/robot-ways/plan` | Plan Way | `WayIn` |  |
| **NEW** | POST | `/api/factory/robot-ways/optimize` | Optimize Way | `WayOptimizeIn` |  |
|  | POST | `/api/factory/robot-ways/check` | Check Way | `WayCheckIn` |  |
|  | GET | `/api/factory/robot-events` | List Robot Events |  | `robot_id`, `limit` |
|  | POST | `/api/factory/robot-telemetry/{gateway_code}` | Ingest Telemetry | `TelemetryIn` |  |

## drawings

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/drawings` | List Drawings |  | `q`, `limit`, `offset` |
|  | POST | `/api/drawings` | Create From Points | `PointsIn` |  |
|  | GET | `/api/drawings/{drawing_id}` | Get Drawing |  |  |
|  | PATCH | `/api/drawings/{drawing_id}` | Rename Drawing | `RenameIn` |  |
|  | DELETE | `/api/drawings/{drawing_id}` | Delete Drawing |  |  |
|  | POST | `/api/drawings/import/dxf` | Import Dxf |  | `note` |
|  | POST | `/api/drawings/import/svg` | Import Svg |  | `note` |

## free-nesting

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | POST | `/api/free-nesting/runs` | Start Run | `RunIn` |  |
|  | GET | `/api/free-nesting/runs/{run_id}` | Get Run |  | `rev` |
|  | POST | `/api/free-nesting/runs/{run_id}/stop` | Stop Run |  |  |
|  | GET | `/api/free-nesting/runs/{run_id}/export` | Export Run |  | `format`, `sheet` |

## compliance

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/compliance/advisories` | List Advisories |  | `product` |
|  | GET | `/api/compliance/advisories/{ref}` | Get Advisory |  |  |
|  | GET | `/api/compliance/support-periods` | List Support Periods |  |  |
|  | POST | `/api/compliance/reports` | Submit Report | `ReportIn` |  |
|  | GET | `/api/compliance/admin/reports` | Admin List Reports |  | `status` |
|  | PATCH | `/api/compliance/admin/reports/{ref}` | Admin Update Report | `ReportPatch` |  |
|  | GET | `/api/compliance/admin/advisories` | Admin List Advisories |  |  |
|  | POST | `/api/compliance/admin/advisories` | Admin Create Advisory | `AdvisoryIn` |  |
|  | PATCH | `/api/compliance/admin/advisories/{ref}` | Admin Update Advisory | `AdvisoryPatch` |  |
|  | PUT | `/api/compliance/admin/support-periods` | Admin Replace Support Periods | `application/json` |  |

## vision

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/vision/status` | Status |  |  |
|  | GET | `/api/vision/zone` | Get Zone |  |  |
|  | PUT | `/api/vision/zone` | Set Zone | `gimel__vision_api__ZoneIn` |  |
|  | DELETE | `/api/vision/zone` | Clear Zone |  |  |
|  | GET | `/api/vision/expected` | Expected |  | `work_order` |
|  | POST | `/api/vision/identify` | Identify |  | `work_order`, `preview` |
|  | POST | `/api/vision/confirm` | Confirm | `ConfirmIn` |  |
|  | DELETE | `/api/vision/confirm/{confirmation_id}` | Undo |  |  |
|  | GET | `/api/vision/sample` | Sample |  | `work_order`, `count`, `seed` |
|  | PUT | `/api/vision/calibration` | Set Calibration | `CalibrationIn` |  |
|  | POST | `/api/vision/calibration/point` | Add Point | `PointIn` |  |
|  | DELETE | `/api/vision/calibration/points` | Clear Points |  |  |
|  | POST | `/api/vision/calibration/rectangle` | Calibrate Rectangle | `RectangleIn` |  |

## agent

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
| **NEW** | GET | `/api/agent/providers` | List Providers |  |  |
| **NEW** | POST | `/api/agent/providers` | Create Provider | `ProviderCreate` |  |
| **NEW** | PUT | `/api/agent/providers/{provider_id}` | Update Provider | `ProviderUpdate` |  |
| **NEW** | DELETE | `/api/agent/providers/{provider_id}` | Delete Provider |  |  |
| **NEW** | POST | `/api/agent/providers/{provider_id}/default` | Default Provider |  |  |
| **NEW** | DELETE | `/api/agent/providers/{provider_id}/key` | Delete Provider Key |  |  |
| **NEW** | POST | `/api/agent/providers/{provider_id}/test` | Test Provider |  |  |
| **NEW** | GET | `/api/agent/providers/{provider_id}/models` | Provider Models |  |  |
| **NEW** | POST | `/api/agent/providers/{provider_id}/models/refresh` | Refresh Provider Models |  |  |
| **NEW** | GET | `/api/agent/config` | Config |  |  |
| **NEW** | GET | `/api/agent/settings` | Read Settings |  |  |
| **NEW** | PUT | `/api/agent/settings` | Write Settings | `SettingsUpdate` |  |
| **NEW** | POST | `/api/agent/settings/reset` | Reset Settings | `SettingsReset` |  |
| **NEW** | POST | `/api/agent/settings/websearch/test` | Test Websearch | `WebSearchTest` |  |
| **NEW** | GET | `/api/agent/chats` | List Chats |  |  |
| **NEW** | POST | `/api/agent/chats` | Create Chat | `ChatCreate` |  |
| **NEW** | GET | `/api/agent/stats` | Stats |  | `days` |
| **NEW** | GET | `/api/agent/chats/{chat_id}` | Get Chat |  |  |
| **NEW** | PATCH | `/api/agent/chats/{chat_id}` | Update Chat | `ChatUpdate` |  |
| **NEW** | DELETE | `/api/agent/chats/{chat_id}` | Delete Chat |  |  |
| **NEW** | POST | `/api/agent/chats/{chat_id}/attachments` | Upload Attachment | `Body_upload_attachment_api_agent_chats__chat_id__attachments_post` |  |
| **NEW** | DELETE | `/api/agent/chats/{chat_id}/attachments/{attachment_id}` | Delete Attachment |  |  |
| **NEW** | POST | `/api/agent/chats/{chat_id}/messages` | Post Message | `MessageIn` |  |
| **NEW** | POST | `/api/agent/chats/{chat_id}/cancel` | Cancel Chat |  |  |
| **NEW** | GET | `/api/agent/changes` | List Changes |  | `chat_id`, `status_filter` |
| **NEW** | POST | `/api/agent/chats/{chat_id}/changes/{change_id}/revert` | Revert Change |  |  |
| **NEW** | POST | `/api/agent/chats/{chat_id}/messages/{message_id}/revert` | Revert Message |  |  |
| **NEW** | POST | `/api/agent/chats/{chat_id}/rewind` | Rewind Chat | `RewindIn` |  |
| **NEW** | GET | `/api/agent/prompts` | List Prompts |  |  |
| **NEW** | POST | `/api/agent/prompts` | Create Prompt | `PromptIn` |  |
| **NEW** | PUT | `/api/agent/prompts/{prompt_id}` | Update Prompt | `PromptUpdate` |  |
| **NEW** | DELETE | `/api/agent/prompts/{prompt_id}` | Delete Prompt |  |  |
| **NEW** | POST | `/api/agent/chats/{chat_id}/tools/{name}` | Invoke Tool | `ToolInvokeIn` |  |
| **NEW** | GET | `/api/agent/tools` | List Tools |  |  |
| **NEW** | GET | `/api/agent/speech` | Speech Info |  |  |
| **NEW** | POST | `/api/agent/speech` | Speak | `SpeechIn` |  |
| **NEW** | GET | `/api/agent/health` | Health |  |  |

## meta

| | Method | Path | Summary | Body | Query |
|---|---|---|---|---|---|
|  | GET | `/api/health` | Health |  |  |
|  | GET | `/api/version` | Version |  |  |
