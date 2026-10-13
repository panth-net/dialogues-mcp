# Jesuit Relations Source Notes

The Jesuit Relations capsule downloads the Thwaites edition (1896-1901) as
Internet Archive OCR text. The volume list is in `../source-manifest.yaml`;
the small first-run sample is in `../sample.yaml`.

```bash
dialogues corpus download jesuit-relations --sample   # three volumes
dialogues corpus download jesuit-relations            # all 73 volumes
dialogues reindex jesuit-relations                    # rebuild from downloaded text
```

Both download commands show the source notice.
Downloaded text and the search file are stored in your Dialogues data folder
(`source-cache/jesuit-relations/` and `indexes/jesuit-relations/`), never in
this capsule. The Thwaites edition is treated as public-domain source material;
the OCR text remains a local user-side copy.
