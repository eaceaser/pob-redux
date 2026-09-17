# Security policy

## Supported versions

Security fixes go into the latest release only. The app shows a banner when a new release is out, so
update before you report a problem.

## Report a vulnerability

Do not open a public issue for a security problem. Report it privately on GitHub:

1. Open [Report a vulnerability](https://github.com/juddisjudd/pob-redux/security/advisories/new) (the
   Security tab, then **Report a vulnerability**).
2. Say what the problem is, which version and operating system you used, and how to reproduce it. A
   proof of concept helps.

The report and the discussion stay private until a fix is released. Say in the report if you want
credit on the published advisory.

## Scope

In scope is the code in this repository, including:

- the desktop app and its updater
- the local MCP server, which listens on localhost and needs a token
- opening `pob://` and `pob2://` links
- how assistant API keys are stored
- the diagnostics report, which should mask paths, tokens and keys

Out of scope:

- Path of Building Community's calculation code, which the app bundles unchanged. Report problems in it
  to [PathOfBuilding-PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) or
  [PathOfBuilding](https://github.com/PathOfBuildingCommunity/PathOfBuilding).
- The websites the app imports builds from, and the AI providers you connect to the assistant.
