# Validation and remaining review

- Archive source SHA-256: ad1c6b78f7e97571c43176a7cd68f03d9c2385176bab86c0b967ae25264336d1.
- Added the missing separate names, confirmed email, calendar birth date, international calling codes, conditional company invoice and initial driver names. Validated on the server and saved with the requester/driver record.
- Fixed test-server routing for document submissions and prevented contract generation with null initial document data.
- The main Word agreement rent now reflects RENTY10, matching its appendix and saved total.
- Added document acknowledgement, camera picker, promotional email opt-out and coupon retry handling. Removed obsolete three-hour settings from the admin UI.
- Added a native PostgreSQL/Chromium GitHub workflow for this PR. Preview emails remain disabled; no production database or secrets are used by tests.

## Locally executed

- Unit tests: 36 passed.
- DOM/API test on bg/en/de: 69 passed, covering the actual form scripts and server endpoints through both approvals. JPEG buffers are injected after image processing; this does not test camera/canvas or layout.
- Two-stage integration: 37 passed; quote binding: 6 passed.
- Regression sets email, mail-guard, auth, booking-flow, cancel, contracts, stage1, isolation passed using TEST_USE_PGLITE=1.
- WASM PostgreSQL is optional test-only support. It does not replace native multi-connection concurrency validation. Default test mode remains native PostgreSQL.
- Native PostgreSQL CI: all 22 integration sets and unit tests passed on the initial feature commit. Native UI checks identified and fixed CSS case-sensitive assertions and fresh-email-session loading.
- Native Chromium cannot start in this local sandbox; native CI results must be inspected before merge. Camera access, real touch interactions and external map tiles need a real-device Preview check.

No merge or production publication has been performed.
