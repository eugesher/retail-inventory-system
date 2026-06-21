import { Injectable } from '@nestjs/common';
import * as Handlebars from 'handlebars';

import { ITemplateRendererPort } from '../../application/ports';

// The only file in the service that imports the Handlebars engine — the
// concrete adapter behind `TEMPLATE_RENDERER` (ADR-004/017: the third-party
// engine import is confined to `infrastructure/`).
//
// `Handlebars.compile` returns a `delegate` function; calling it with the render
// context produces the final string. We compile per call: acceptable at this
// volume, and a compiled-template cache keyed by template id+version is a noted
// future optimization (the unconsumed `CACHE_KEYS.notificationsTemplate(...)`
// key is where it would live).
//
// Security posture: `{{ }}` interpolation HTML-escapes its value by default,
// which is the correct default for any channel that may render as HTML (email).
// Template *source* is trusted (staff-authored under `notifications:write`); the
// render *context* (order numbers, names, addresses) is data. Do NOT switch to
// `{{{ triple-stache }}}` for context-derived values — un-sanitized data must
// never be emitted unescaped.
@Injectable()
export class HandlebarsTemplateRendererAdapter implements ITemplateRendererPort {
  public render(source: string, context: Record<string, unknown>): string {
    const template = Handlebars.compile(source);

    return template(context);
  }
}
