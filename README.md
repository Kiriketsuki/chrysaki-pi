# chrysaki-pi

Independent Pi theme integration for the Chrysaki ecosystem. The generated theme maps every required Pi role to the pinned [`chrysaki-core` v1.0.0](https://github.com/Kiriketsuki/chrysaki-core/releases/tag/v1.0.0) contract; application-specific role choices remain in this repository.

## Install

```bash
pi install git:github.com/Kiriketsuki/chrysaki-pi@v1.0.0
```

Select `chrysaki` in `/settings` or set:

```json
{ "theme": "chrysaki" }
```

The Git ref and core dependency are both pinned. A newer core release cannot change this theme until this repository deliberately updates its dependency and generated output.

## Remove or roll back

```bash
pi remove git:github.com/Kiriketsuki/chrysaki-pi
```

To roll back, reinstall the previous package tag and reselect its theme. Installation and removal do not modify tmux or other dotfiles.

## Development

```bash
npm ci
npm run check
```

`themes/chrysaki.json` is generated and committed. Core palette changes belong in `chrysaki-core`; Pi role mappings belong here.

The broader responsive interface suite is tracked separately under `docs/specs/` and is not part of the initial extraction contract.
