# Releasing

Only `.github/workflows/release.yml` publishes, from a pushed tag `vX.Y.Z` on
this repository. It runs the tests, the build and the smoke test, publishes
to npm with provenance through npm trusted publishing (no npm token exists
anywhere), and attaches `motionmockups.mcpb`, the Claude Desktop extension,
to a GitHub release. Never run `npm publish` from a computer.

## Once

1. **Trusted publishing.** On npmjs.com, open the `motionmockups` package's
   Settings, then Trusted Publisher, and choose GitHub Actions:
   - organization or user `krysjezek`, repository `motionmockups-mcp`;
   - workflow filename `release.yml`; no environment;
   - allowed actions: tick `npm publish`.

   A new configuration must publish once within 2 days, or it expires and
   has to be made again, so set it up just before the first release.
2. **Two-factor authentication.** Turn on 2FA for the npm account. Then, in
   the package's Settings, Publishing access, choose "Require two-factor
   authentication and disallow tokens". Trusted publishing keeps working.

## Each release

1. Bump the version: `npm version X.Y.Z --no-git-tag-version`, then update
   the README if the install lines change (they pin `motionmockups@1` from
   1.0.0 on). Commit, push `main` and wait for CI to be green.
2. Tag and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The workflow refuses a tag that is not `v` + `package.json`'s version.
   A `v0.*` tag or a prerelease (`-beta.1`) makes a GitHub prerelease.
3. Watch the Release run in the Actions tab until both jobs are green.
4. Check provenance: the package page on npmjs.com shows "Built and signed
   on GitHub Actions" linking this repository, the workflow and the tag's
   commit, and `npm audit signatures` in a project that installs it reports
   a verified attestation.
5. Check the GitHub release carries `motionmockups.mcpb`.

If something went wrong after publishing, block the version with the site's
kill switch (README, "Kill switch") and publish a fixed one; npm versions
cannot be republished.
