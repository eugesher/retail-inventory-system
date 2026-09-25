export const TEMPLATE_RENDERER = Symbol('TEMPLATE_RENDERER');

export interface ITemplateRendererPort {
  render(source: string, context: Record<string, unknown>): string;
}
