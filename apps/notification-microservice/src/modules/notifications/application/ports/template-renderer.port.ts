export const TEMPLATE_RENDERER = Symbol('TEMPLATE_RENDERER');

// The seam the Render & Dispatch use case depends on: it compiles a template
// `source` string (a subject or body) against a render `context` and returns the
// rendered string. Keeping it behind a port lets the use case be unit-tested with a
// trivial fake instead of a real template engine. The concrete engine import
// (Handlebars) is confined to the `infrastructure/render/` adapter (ADR-004/017).
//
// Synchronous on purpose: Handlebars compile/execute is synchronous, so the seam
// stays as simple as the work it fronts. A `null`/absent subject (sms/push templates)
// is the use case's concern — the renderer renders whatever non-null string it is handed.
export interface ITemplateRendererPort {
  render(source: string, context: Record<string, unknown>): string;
}
