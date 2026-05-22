# Project Notes

This fixture represents the kind of `CLAUDE.md` an operator hand-edits across the canon-md round-trip. The byte-level invariant under test is: every character outside the canon section markers is preserved exactly. Trailing whitespace, indentation, list markers, blockquotes, code fences, table pipes, embedded HTML comments, YAML-like metadata blocks, and mixed line endings all stay intact.

## Operator preferences

Some operator notes that live before the canon block:

- Prefer small PRs.
- Default reviewer is the on-call rotation.
- Mobile viewports are the floor; desktop is enhancement.

## Frontmatter-shaped metadata

```yaml
deployment:
  tier: indie-floor
  org_dial: default
  apex_signed_at: 2026-05-22T17:00:00Z
```

## A reference table

| Surface  | Owner    | Last touched |
|----------|----------|--------------|
| README   | operator | 2026-05-21   |
| Console  | cto      | 2026-05-22   |
| Runbooks | ceo      | 2026-05-22   |

## A blockquote

> "Build the deterministic rules, then tune the autonomy dial." Quoted from canon as the operator's working principle.

## Indented code

<!-- markdownlint-disable-next-line MD046 -->
    function exampleHandler(input) {
        return input.trim();
    }

## Existing canon section

<!-- lag:canon-start -->
existing canon body that the renderer will replace
<!-- lag:canon-end -->

## Post-canon notes

These trailing notes live AFTER the canon block. They include a tab here:	end-of-tab.

A line ending with two trailing spaces:  
breaks softly.

Final paragraph; the file ends with a single trailing newline.
