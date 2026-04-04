# Publish Guide

## Repo layout

You only need one GitHub repository for this project.

This repo publishes two npm packages from the same monorepo:

- plugin package
- installer CLI package

That is the cleanest layout for open source and for future maintenance.

## Before publishing

1. Create a GitHub repo for `openclaw-xiaozhi`.
2. Create or choose an npm scope that you control.
3. Update package names and repo links with:

```bash
cd openclaw-xiaozhi
node ./scripts/prepare-publish.mjs \
  --scope @your-npm-scope \
  --repo https://github.com/your-name/openclaw-xiaozhi
```

This updates:

- `packages/openclaw-xiaozhi/package.json`
- `packages/openclaw-xiaozhi-cli/package.json`
- the CLI default plugin package target

## Why not `@openclaw/*`

`@openclaw/*` can only be published if you control the `openclaw` npm scope.

The npm docs state that each npm user or organization owns only their own scope.

## Publish options

### Option A: local publish

```bash
cd openclaw-xiaozhi
npm login
npm publish ./packages/openclaw-xiaozhi --access public
npm publish ./packages/openclaw-xiaozhi-cli --access public
```

### Option B: GitHub Actions

This repo already includes `.github/workflows/publish.yml`.

Recommended path:

1. push this folder as its own GitHub repo
2. configure npm trusted publishing or `NPM_TOKEN`
3. run the workflow manually

## After publishing

Once published, the OpenClaw machine can install remotely with:

```bash
npx -y @your-npm-scope/openclaw-xiaozhi-cli@latest install
```
