import { Injectable } from '@nestjs/common';
import * as Handlebars from 'handlebars';

import { ITemplateRendererPort } from '../../application/ports';

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
