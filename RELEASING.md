# Releasing

Only `.github/workflows/release.yml` publishes, from a pushed tag `vX.Y.Z` of a
commit on `main` in this repository. Its `build` job runs the tests, the build,
the smoke test and `npm pack`, with no publishing rights. Its `publish` job
publishes that tested tarball to npm with provenance through npm trusted
publishing (no npm token exists anywhere), and runs no project code. Its
`release` job attaches `motionmockups.mcpb`, the Claude Desktop extension, to
a GitHub release. Never run `npm publish` from a computer.

## Once

1. **Trusted publishing.** On npmjs.com, open the `motionmockups` package's
   Settings, then Trusted Publisher, and choose GitHub Actions:
   - organization or user `krysjezek`, repository `motionmockups-mcp`;
   - workflow filename `release.yml`;
   - allowed actions: tick `npm publish`.

   A new configuration must publish once within 2 days, or it expires and
   has to be made again, so set it up just before the first release.

   Optionally, bind a GitHub environment: create an environment (say
   `npm`) in the repository's Settings, Environments, with yourself as a
   required reviewer, add `environment: npm` to the `publish` job, and name
   the same environment in the trusted publisher. Each publish then waits
   for your approval.
2. **Two-factor authentication.** Turn on 2FA for the npm account. Then, in
   the package's Settings, Publishing access, choose "Require two-factor
   authentication and disallow tokens". Trusted publishing keeps working.
3. **Who can tag.** In the repository's Settings, Rules, Rulesets, add a tag
   ruleset targeting `v*` that restricts creations, updates and deletions,
   with only yourself (repository admin) in the bypass list. The workflow
   also refuses a tag whose commit is not on `main`.
4. **Accept what the extension shows and carries.**
   - The bundle and the manifest carry two public identifiers: the
     repository name `krysjezek/motionmockups-mcp`, and the site's Vercel
     preview suffix `krystofjezeks-projects` (in the origin allowlist,
     `src/origin.ts`, and the README). Setting a Vercel Preview Deployment
     Suffix on a domain of your own, an open owner item, would remove the
     second; then change `src/origin.ts`.
   - The extension's settings in Claude Desktop show "Site origin (testing
     only)" next to the folders. The manifest format cannot hide a setting.
     It is optional and empty by default. Removing it from
     `scripts/mcpb.mjs` is your choice; the extension then always uses
     motionmockups.com.

## Each release

1. Bump the version: `npm version X.Y.Z --no-git-tag-version`, then update
   the README if the install lines change (they pin `motionmockups@1` from
   1.0.0 on). Commit, push `main` and wait for CI to be green.
2. Tag the commit on `main` and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The workflow refuses a tag that is not `v` + `package.json`'s version,
   or whose commit is not on `main`. A prerelease version (`X.Y.Z-beta.1`)
   is published under the npm dist-tag `next`, never `latest`. A `v0.*` tag
   or a prerelease makes a GitHub prerelease.
3. Watch the Release run in the Actions tab until all three jobs are green.
4. Check provenance: the package page on npmjs.com shows "Built and signed
   on GitHub Actions" linking this repository, the workflow and the tag's
   commit, and `npm audit signatures` in a project that installs it reports
   a verified attestation.
5. Check the GitHub release carries `motionmockups.mcpb`.

If something went wrong after publishing, block the version with the site's
kill switch (README, "Kill switch") and publish a fixed one; npm versions
cannot be republished.
