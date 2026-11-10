# Main protection manifest

This page records the main-branch settings the owner still has to apply. Nothing in this file changes GitHub settings. This repository does not deploy itself from a pull request.

## Pull requests and the required test

Merges to main go through a pull request. The pull request must pass the GitHub Actions check `required-test` from `.github/workflows/ci.yml`.

That job installs dependencies, then runs lint, typecheck, the Node tests, the Worker tests, the fake-data check, demo browser acceptance, and a redacted secret scan. Demo browser acceptance runs `test/demo/browser` through `vitest.browser.config.ts` when that directory contains tests. The Node suite does not include that directory. Until those tests are in the revision, the step says so and does not fail the job. The secret scan reads commits reachable from the revision under test. It redacts values and does not scan other branches.

The conventions workflow keeps its own job. Do not treat a check named `check` as this test job. On the first green run, copy the check name GitHub shows if the UI prefixes the workflow, and require that exact name. Do not remove other required checks.

## Scanners and alerts

Keep secret scanning enabled. Keep secret scanning push protection enabled. Enable Dependabot alerts if they are off. This page does not turn on automatic security updates.

## Merge method

Allow merge commits only. Turn off squash merges. Turn off rebase merges. Keep the existing blocks on force-push and branch deletion. Do not delete other protection rules to clear a failing check.

## Conventions promotion blocker

These four commits are already on `m1-integration` and fail `scripts/check_conventions.py`. This change does not edit the checker and does not add an exemption. A later commit cannot change those objects. Promoting `m1-integration` to main stays blocked until the owner approves a separate resolution.

- `e89c032b5fa54c4a9f1e07271b4fad21f5e86dc3` — missing authorship
- `9569edca40af5969bbd5ba4578d06637f44815af` — missing authorship
- `34dc0dfe8948f071053fb8a9029f667ac1f214a4` — subject format and missing authorship
- `43461563cbf32928f1bba28e88c2078f73d96956` — missing authorship

## Public demo deploy

`.github/workflows/production-deploy.yml` is the deploy path. Someone dispatches it by hand. It does not run on a pull request, a push, or a tag. The job uses the GitHub environment `production` and sets the deployment URL from the variable `COMMONA_DEMO_ENVIRONMENT_URL`. Actions are pinned to commit ids. The job can read the repository and write the deployment status. It cannot push.

Before the first dispatch, the owner does all of the following.

1. Approve the exact public hostname. `wrangler.demo.toml` keeps `example.invalid` and an all-zero account id until that approval is written into the production environment, not into the committed file.
2. Create the GitHub environment `production` and require a reviewer on it.
3. Set the environment variable `COMMONA_DEMO_ENVIRONMENT_URL` to that https origin, with no path.
4. Set the environment variable `COMMONA_DEMO_ACCOUNT_ID` to the account id. That value stays out of the repository.
5. Create a new least-privilege token that can deploy only the `commona-demo` Worker. Store it as the environment secret `COMMONA_DEMO_DEPLOY_TOKEN`. Do not reuse a token from a workstation, and do not put a token in the repository, a log, or a chat.
6. Dispatch the workflow with the full commit id of the current main tip, and only after this config and the public demo entry are on that commit. The workflow refuses any other commit. It deploys the separate demo Worker, requests the origin, and succeeds only when that request returns 200. A failed request leaves the GitHub deployment failed.

`wrangler.demo.toml` is a different Worker from `wrangler.toml`. It does not bind the private directory. `workers_dev` is false, so a deploy does not publish a workers.dev hostname. The workflow renders a temporary config from the approved variables and deletes that file afterward. The committed file keeps the placeholders.

## Secret-scan candidates

Gitleaks 8.30.1 reports two `curl-auth-header` matches in `docs/runbooks/g2-hosted-dry-run.md` at commit `ae1fc3f5bc0e3f9a51553fcdffb26dd6ab391e8b`, starting at lines 241 and 307. That commit is not in the history of `m1-integration`. The captured header values are short uppercase labels made of two ordinary words joined by an underscore. They are placeholders in a dry-run example. They are not the 43-character tokens this repository issues, and they are not live credentials. The values are not written down here. This note does not say that every other branch, or every deleted commit, is free of secrets.
