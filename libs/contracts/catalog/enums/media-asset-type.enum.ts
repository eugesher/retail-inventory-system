// The kind of media a `MediaAsset` references — an image, a video, or a document
// (e.g. a spec sheet or manual). It is a classification of the already-uploaded
// resource at `uri`, not a constraint on the URI itself: the URI is opaque (no
// scheme/extension is parsed — ADR-029 §4), so this enum is what a storefront
// keys on to decide how to render the asset (an `<img>` vs a `<video>` vs a
// download link).
//
// This is a WIRE CONTRACT: it rides the `catalog.media.attach` command and
// surfaces on `MediaAssetView`, so it lives in `libs/contracts` — unlike the
// lifecycle `MediaAssetStatusEnum`, which stays in the catalog `domain/`
// (ADR-025 §7).
export enum MediaAssetTypeEnum {
  IMAGE = 'image',
  VIDEO = 'video',
  DOCUMENT = 'document',
}
