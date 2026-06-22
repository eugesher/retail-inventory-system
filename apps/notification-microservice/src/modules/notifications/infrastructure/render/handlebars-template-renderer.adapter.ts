import { Injectable } from '@nestjs/common';
import * as Handlebars from 'handlebars';

import { ITemplateRendererPort } from '../../application/ports';

// The only file in the service that imports the Handlebars engine — the
// concrete adapter behind `TEMPLATE_RENDERER` (ADR-004/017: the third-party
// engine import is confined to `infrastructure/`).
//
// `Handlebars.compile` returns a `delegate` function; calling it with the render
// context produces the final string. Compilation (lex + AST + codegen) is pure for a
// given source string, so the delegate is memoized in a small in-process map keyed by
// the source — the same active template is compiled once, not on every dispatch (the
// hottest path in the service). A new template version is a new source string and gets
// its own entry; the live registry is tiny so the map stays bounded.
//
// Security posture: `{{ }}` interpolation HTML-escapes its value by default,
// which is the correct default for any channel that may render as HTML (email).
// Template *source* is trusted (staff-authored under `notifications:write`); the
// render *context* (order numbers, names, addresses) is data. Do NOT switch to
// `{{{ triple-stache }}}` for context-derived values — un-sanitized data must
// never be emitted unescaped.
@Injectable()
export class HandlebarsTemplateRendererAdapter implements ITemplateRendererPort {
  private readonly compiled = new Map<string, Handlebars.TemplateDelegate>();

  public render(source: string, context: Record<string, unknown>): string {
    let template = this.compiled.get(source);
    if (template === undefined) {
      template = Handlebars.compile(source);
      this.compiled.set(source, template);
    }

    return template(context);
  }
}
