import { CatalogDomainException, CatalogErrorCodeEnum, Category, CategoryStatusEnum } from '..';

// Reconstitutes a category at a known path/status — the spec's stand-in for a
// row already in the DB (factory `create` always starts `active` at version 0).
const makeCategory = (
  overrides: Partial<{
    id: number | null;
    name: string;
    slug: string;
    parentId: number | null;
    path: string;
    sortOrder: number;
    status: CategoryStatusEnum;
  }> = {},
): Category =>
  Category.reconstitute({
    id: overrides.id ?? 1,
    name: overrides.name ?? 'Electronics',
    slug: overrides.slug ?? 'electronics',
    parentId: overrides.parentId ?? null,
    path: overrides.path ?? '/electronics',
    sortOrder: overrides.sortOrder ?? 0,
    status: overrides.status ?? CategoryStatusEnum.ACTIVE,
  });

// Asserts the thrown error is a CatalogDomainException carrying the EXACT code,
// never matching on the (free-text) message.
const expectCode = (fn: () => unknown, code: CatalogErrorCodeEnum): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CatalogDomainException);
    expect((err as CatalogDomainException).code).toBe(code);
    return;
  }
  throw new Error(`expected a CatalogDomainException(${code}) but nothing was thrown`);
};

describe('Category', () => {
  describe('create — path derivation', () => {
    it('derives a root path of `/<slug>` when there is no parent', () => {
      const root = Category.create({ name: 'Electronics', slug: 'electronics' });

      expect(root.parentId).toBeNull();
      expect(root.path).toBe('/electronics');
      expect(root.status).toBe(CategoryStatusEnum.ACTIVE);
      expect(root.sortOrder).toBe(0);
      expect(root.id).toBeNull();
    });

    it('derives a child path of `parent.path + /<slug>`', () => {
      const parent = makeCategory({ id: 5, slug: 'electronics', path: '/electronics' });

      const child = Category.create({ name: 'Phones', slug: 'phones', parent });

      expect(child.parentId).toBe(5);
      expect(child.path).toBe('/electronics/phones');
    });

    it('records no domain events', () => {
      const root = Category.create({ name: 'Electronics', slug: 'electronics' });
      expect(root.pullDomainEvents()).toHaveLength(0);
    });
  });

  describe('invariants', () => {
    it('rejects an empty name', () => {
      expectCode(
        () => Category.create({ name: '   ', slug: 'electronics' }),
        CatalogErrorCodeEnum.CATEGORY_NAME_REQUIRED,
      );
    });

    it.each(['Bad Slug', '-x', 'x-', 'x--y', 'Electronics', 'phones/audio', ''])(
      'rejects the non-kebab-case slug %p',
      (slug) => {
        expectCode(
          () => Category.create({ name: 'Anything', slug }),
          CatalogErrorCodeEnum.CATEGORY_SLUG_INVALID,
        );
      },
    );

    it.each(['electronics', 'home-audio', 'a1', 'phones-2024'])(
      'accepts the kebab-case slug %p',
      (slug) => {
        expect(() => Category.create({ name: 'Anything', slug })).not.toThrow();
      },
    );

    it.each([-1, 1.5, Number.NaN])('rejects the invalid sortOrder %p', (sortOrder) => {
      expectCode(
        () => Category.create({ name: 'Electronics', slug: 'electronics', sortOrder }),
        CatalogErrorCodeEnum.CATEGORY_SORT_ORDER_INVALID,
      );
    });
  });

  describe('isAncestorOfOrSelf — pure prefix test', () => {
    it('is true for self (same path)', () => {
      const a = makeCategory({ path: '/a' });
      expect(a.isAncestorOfOrSelf(a)).toBe(true);
    });

    it('is true for a strict descendant', () => {
      const a = makeCategory({ path: '/a' });
      const descendant = makeCategory({ id: 2, slug: 'b', path: '/a/b' });
      expect(a.isAncestorOfOrSelf(descendant)).toBe(true);
    });

    it('is FALSE for a sibling-prefix `/ab` (the `/` boundary matters)', () => {
      const a = makeCategory({ path: '/a' });
      const ab = makeCategory({ id: 3, slug: 'ab', path: '/ab' });
      expect(a.isAncestorOfOrSelf(ab)).toBe(false);
    });

    it('is false for an unrelated path', () => {
      const a = makeCategory({ path: '/a' });
      const other = makeCategory({ id: 4, slug: 'x', path: '/x' });
      expect(a.isAncestorOfOrSelf(other)).toBe(false);
    });
  });

  describe('reparentUnder — recomputes own path', () => {
    it('moves a child under another root and rewrites its own path', () => {
      const child = makeCategory({
        id: 10,
        slug: 'phones',
        parentId: 5,
        path: '/electronics/phones',
      });
      const newParent = makeCategory({ id: 7, slug: 'gadgets', path: '/gadgets' });

      child.reparentUnder(newParent);

      expect(child.parentId).toBe(7);
      expect(child.path).toBe('/gadgets/phones');
    });

    it('demotes a child to a root when reparented under null', () => {
      const child = makeCategory({
        id: 10,
        slug: 'phones',
        parentId: 5,
        path: '/electronics/phones',
      });

      child.reparentUnder(null);

      expect(child.parentId).toBeNull();
      expect(child.path).toBe('/phones');
    });

    it('rejects reparenting a category under itself with CATEGORY_CYCLE', () => {
      const a = makeCategory({ id: 1, slug: 'a', path: '/a' });

      expectCode(() => a.reparentUnder(a), CatalogErrorCodeEnum.CATEGORY_CYCLE);
      // Path is untouched after the rejected move.
      expect(a.path).toBe('/a');
    });

    it('rejects reparenting a category under one of its own descendants with CATEGORY_CYCLE', () => {
      const a = makeCategory({ id: 1, slug: 'a', path: '/a' });
      const descendant = makeCategory({ id: 2, slug: 'b', parentId: 1, path: '/a/b' });

      expectCode(() => a.reparentUnder(descendant), CatalogErrorCodeEnum.CATEGORY_CYCLE);
      expect(a.parentId).toBeNull();
      expect(a.path).toBe('/a');
    });
  });

  describe('archive — active → archived', () => {
    it('flips an active category to archived', () => {
      const category = makeCategory({ status: CategoryStatusEnum.ACTIVE });

      category.archive();

      expect(category.status).toBe(CategoryStatusEnum.ARCHIVED);
      expect(category.isArchived()).toBe(true);
    });

    it('rejects archiving an already-archived category (terminal)', () => {
      const category = makeCategory({ status: CategoryStatusEnum.ARCHIVED });

      expectCode(() => category.archive(), CatalogErrorCodeEnum.CATEGORY_INVALID_STATE_TRANSITION);
    });
  });
});
