# Publishing @nokv-lab/dsh-nokv

The package is ready to publish; the two steps below need a human with the
accounts. Everything else (README, locale metadata, icon, detail document and
its preview, the bundle patch) is already in the package.

## 1. npm

```bash
cd dsh-nokv
npm login                      # the account that will own the package
npm publish --access public    # publishes @nokv-lab/dsh-nokv@0.2.1
```

`npm view @nokv-lab/dsh-nokv@0.2.1 version` confirms the publish. The package declares
`engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`; the market index must copy that range
unchanged.

Before each release: bump `version`, run `node --test test/`, then publish.

### Deprecating the unscoped package

The package previously existed as unscoped `dsh-nokv` (owned by the same
account). After the first scoped release, point it at the new name:

```bash
npm deprecate dsh-nokv "Renamed to @nokv-lab/dsh-nokv. Install @nokv-lab/dsh-nokv instead."
```

The unscoped copy keeps its last version for reproducibility; new installs
follow the deprecation message.

## 2. A plugin market index

DSH's Discover tab reads a format-1 JSON index from an https URL. Two ways to
make this plugin appear in it:

### a. Self-hosted index (fast, no third-party review)

`market/index.json` in this directory is that index with one entry. It is
served from this repository by jsDelivr:

```
https://cdn.jsdelivr.net/gh/NoKV-Lab/dsh-nokv@main/market/index.json
```

The npm package also carries the same file, but the repository copy is the
canonical one: the timestamp can be corrected in a commit instead of another
publish.

Then add that URL in **Plugins → Discover → Add index source** (or Settings).
Update the entry's `versions` array on each release: `version` must equal the
npm version, `publishTimestamp` is epoch seconds of the publish, and
`engines.dsh` must stay identical to the manifest's.

### b. The Awesome DSH Plugin list

<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> — open a PR that

1. adds one line to the right category in `README.md` (and its `README.zh.md`):

   ```markdown
   - [NoKV-Lab/dsh-nokv](https://github.com/NoKV-Lab/dsh-nokv) - NoKV workspace state as DSH tools: versioned workbenches with generation-fenced writes, commits, snapshots, forks, and workspace search.
   ```

2. passes their checks: it installs with `dsh plugin add @nokv-lab/dsh-nokv`, the one-line
   description matches what the plugin actually does, and the entry sits in the
   right category.

That list is also published as the format-1 index
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`, so a merged PR
makes the plugin show up in Discover for every DSH user who adds that source.

## 3. Where the source lives

The source is the repository root of
<https://github.com/NoKV-Lab/dsh-nokv>, next to NoKV itself in the same
organization. The package is self-contained (no build step, no dependencies).
