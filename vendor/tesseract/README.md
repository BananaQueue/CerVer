# Vendored Tesseract language data

`eng.traineddata`, the `tessdata_fast` variant, from
https://github.com/tesseract-ocr/tessdata_fast

**Why it is committed rather than downloaded.** tesseract.js fetches this from a
CDN on first use. That would make page-image comparison depend on the internet
and fail closed in the offline setting CerVer is built for. `src/ocr.js` points
`langPath` here so nothing is ever fetched at runtime.

**Why it is not in `public/vendor/`.** `public/` is served statically to every
browser. This file is read only by the server; putting it there would ship
megabytes to every phone that loads the scan page and never use them.

Size: 4,113,088 bytes (measured, not estimated). English only — see spec §8.
