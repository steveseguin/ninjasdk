# Contributing to VDO.Ninja SDK

Thank you for considering a contribution! This document outlines how to get
started and what to expect.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/steveseguin/ninjasdk.git
cd ninjasdk

# Install dependencies
npm install

# Install a WebRTC implementation for Node.js tests
npm install @roamhq/wrtc

# Run tests
npm test

# Build minified SDK
npm run build
```

## Pull Request Guidelines

1. **PRs are strongly preferred over private forks.**  
   Contributing changes back ensures the SDK exception (allowing unmodified
   official builds in proprietary apps) is maintained for everyone. A unified
   SDK and API is a core goal of this project.

2. **If the "byte-for-byte identical" requirement is problematic for your use
   case**, open a PR to request an additional build variant. We're happy to
   include it in the official distribution.

3. **Keep PRs focused.** One feature or fix per PR makes review easier.

4. **Include tests if applicable.** The test suite is in `run-all-tests.js`.

5. **Run `npm test` and `npm run build` before submitting** to make sure
   everything passes and the minified output is up to date.

## Contributor License Agreement (CLA)

By submitting a pull request, you agree to the [CLA](CLA.md). In short, you
assign your contribution rights to the maintainer so that:

- The SDK exception can be preserved.
- Future licensing decisions can be made consistently without needing to contact
  every contributor.

If you have concerns about the CLA, please open an issue before contributing.

## Code Style

- Use 4-space indentation.
- Keep lines under 120 characters where practical.
- Use descriptive variable/function names.
- Add JSDoc comments for public APIs.
- No trailing whitespace.

## Reporting Issues

- Search existing issues before opening a new one.
- Include steps to reproduce, expected vs. actual behavior, and environment
  details (browser/Node version, OS, etc.).

## Questions?

Open an issue or join the [Discord community](https://discord.vdo.ninja).

---

Thanks for helping make VDO.Ninja SDK better!
