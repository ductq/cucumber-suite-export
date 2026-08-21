# CucumberStudio Export / Upload Scripts

Two portable Node scripts for a CucumberStudio project:

- **Export** — download every folder’s `.feature` file and rebuild the tree under `./features/`
- **Upload** — mirror a local tree under `./upload/` into CucumberStudio so the remote Features section matches that tree **exactly**

Both scripts share the same `.env` credentials. They are standalone (no npm package).

## Prerequisites

1. **Node.js** v18 or higher (`node -v`). Download from [nodejs.org](https://nodejs.org/) if needed.
2. A CucumberStudio account with access to the project.

## Setup

1. Keep `export-features.mjs`, `upload-features.mjs`, and `.env.example` in the same folder.
2. **Find your Project ID**:
   - Log into [CucumberStudio](https://studio.cucumberstudio.com/).
   - Open the project.
   - The URL looks like `https://studio.cucumberstudio.com/projects/123456/...`
   - The number after `/projects/` is the **Project ID**.
3. Copy `.env.example` to `.env` and fill in:

```env
EMAIL=your_actual_email@example.com
PASSWORD=your_actual_password
PROJECT_ID=123456
```

Do not put quotes around the values.

---

## Export (`export-features.mjs`)

Downloads all `.feature` files and recreates the CucumberStudio folder hierarchy under `./features/`.

```bash
node export-features.mjs
```

Each Studio **folder** is one feature. The exporter writes:

```
features/<path>/<FolderName>/<FolderName>.feature
```

---

## Upload (`upload-features.mjs`)

Reverse of export: reads a **dynamic** local tree (default `./upload/`) and makes the CucumberStudio project match it exactly — create missing folders, update Gherkin, **delete extra remote folders**, and wipe leftover scenarios that are not in the local file.

### Folder-as-feature layout

Put the suite inside `upload/` using the same shape export produces. The tree can change between runs; the script does not hardcode names.

```
upload/
  Distribution Cable Renewal/
    Distribution Cable Renewal.feature
    Login/
      Login.feature
```

- Directory `Login/` + `Login.feature` → remote folder `Login` with that Gherkin.
- Nested directories become nested folders.
- Top-level children of `upload/` become top-level Studio folders.
- A loose `Foo.feature` (stem ≠ parent folder name) becomes a child folder named `Foo`.
- A directory with no matching `.feature` is still created as an empty grouping folder. The uploader does **not** import a dummy `Feature: <name>` file — CucumberStudio would turn that into a nested folder with the same name.
- Non-`.feature` files are ignored.

If `upload/` is missing or contains no `.feature` files, the script exits and does **not** apply changes (that would wipe the remote suite).

### Dry-run vs apply

Default is **dry-run**: it authenticates, diffs, and prints the plan. Nothing is written.

```bash
node upload-features.mjs                  # dry-run exact plan
node upload-features.mjs --dir ./upload   # override source directory
node upload-features.mjs --apply          # write; type yes if any deletes
node upload-features.mjs --apply --yes    # write without the delete prompt
```

### Exact mirror — deletes

`--apply` **permanently deletes** remote folders (and their children/scenarios) that are not in `./upload`. Renames and moves are delete-old + create-new (Studio ids are not preserved).

If the plan includes deletes, you must type `yes` unless you pass `--yes`.

Use dry-run first and read the `DELETE` list before applying.

---

## Rate limit

Both scripts pause ~350ms between API calls (~170 req/min) to stay under CucumberStudio’s 200 req/min limit.
