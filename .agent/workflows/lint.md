---
description: Check and fix all lint issues
---

This workflow runs lint and tests, then commits and pushes once clean.

* Run `pnpm lint` in the base directory
* Fix all discovered issues and re-run `pnpm lint` until clean
* Run `pnpm test` in the base directory
* Fix all discovered issues, then re-run from the top - lint, then tests
* Once all lint and all tests are clean, `git commit` and `git push` all the code changes
* Remove any temp files created during the above

Rules:

* Try to keep changes small, don't embark on large refactors without asking the user.
* Don't change the lint rules, assume they apply always.
* Don't exempt things from lint - if you can't find a clean elegant solution, ask me.
* Fix all unrelated lint and test issues as well as ones related to your changes.