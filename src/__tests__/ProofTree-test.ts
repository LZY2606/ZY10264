/**
 * Tests for the optional proof tree that explains how the query complexity
 * was calculated.
 */

import {
  parse,
  TypeInfo,
  visit,
  visitWithTypeInfo,
  DocumentNode,
} from 'graphql';

import { expect } from 'chai';

import schema from './fixtures/schema.js';

import ComplexityVisitor, {
  getComplexity,
  ComplexityEstimator,
  OperationProofNode,
  FieldProofNode,
  FragmentProofNode,
} from '../QueryComplexity.js';
import { simpleEstimator, fieldExtensionsEstimator } from '../index.js';
import { CompatibleValidationContext } from './fixtures/CompatibleValidationContext.js';

describe('QueryComplexity proof tree', () => {
  const estimators = (): ComplexityEstimator[] => [
    fieldExtensionsEstimator(),
    simpleEstimator({ defaultComplexity: 1 }),
  ];

  function analyze(
    ast: DocumentNode,
    estimatorList: ComplexityEstimator[],
    options: {
      variables?: Record<string, unknown>;
      operationName?: string;
      proofTree?: boolean;
    } = {}
  ): { context: CompatibleValidationContext; visitor: ComplexityVisitor } {
    const typeInfo = new TypeInfo(schema);
    const context = new CompatibleValidationContext(schema, ast, typeInfo);
    const visitor = new ComplexityVisitor(context, {
      maximumComplexity: 10000,
      estimators: estimatorList,
      variables: options.variables,
      operationName: options.operationName,
      proofTree: options.proofTree ?? true,
    });
    visit(ast, visitWithTypeInfo(typeInfo, visitor));
    return { context, visitor };
  }

  it('expands a fragment diamond as separate occurrences', () => {
    const ast = parse(`
      query {
        ...A
      }
      fragment A on Query { ...B ...C }
      fragment B on Query { scalar ...D }
      fragment C on Query { name ...D }
      fragment D on Query { complexScalar }
    `);

    const { visitor } = analyze(ast, estimators());
    // Old API return value is identical with and without the proof tree
    const plain = getComplexity({
      estimators: estimators(),
      schema,
      query: ast,
    });
    expect(visitor.complexity).to.equal(42);
    expect(plain).to.equal(42);

    const proof = visitor.proofTree as OperationProofNode[];
    expect(proof).to.have.length(1);
    const operation = proof[0];
    expect(operation.kind).to.equal('OperationDefinition');
    expect(operation.operation).to.equal('query');
    // The total is strictly reduced from the tree
    expect(operation.complexity).to.equal(42);

    // Node order follows the document order
    expect(operation.children.map((node) => node.kind)).to.deep.equal([
      'FragmentSpread',
    ]);
    const spreadA = operation.children[0] as FragmentProofNode;
    expect(spreadA.fragmentName).to.equal('A');
    expect(spreadA.path).to.deep.equal(['...A']);
    expect(
      spreadA.children.map((node) => (node as FragmentProofNode).fragmentName)
    ).to.deep.equal(['B', 'C']);

    const spreadB = spreadA.children[0] as FragmentProofNode;
    const spreadC = spreadA.children[1] as FragmentProofNode;
    expect(spreadB.complexity).to.equal(21);
    expect(spreadC.complexity).to.equal(21);

    // The same fragment expanded at two response paths is two occurrences
    const occurrence1 = spreadB.children[1] as FragmentProofNode;
    const occurrence2 = spreadC.children[1] as FragmentProofNode;
    expect(occurrence1.fragmentName).to.equal('D');
    expect(occurrence2.fragmentName).to.equal('D');
    expect(occurrence1.path).to.deep.equal(['...A', '...B', '...D']);
    expect(occurrence2.path).to.deep.equal(['...A', '...C', '...D']);
    expect(occurrence1.complexity).to.equal(20);
    expect(occurrence2.complexity).to.equal(20);
    expect(occurrence1.cycle).to.equal(undefined);
    expect(occurrence2.cycle).to.equal(undefined);
  });

  it('blocks cyclic fragment spreads via the traversal stack', () => {
    const ast = parse(`
      query {
        ...X
      }
      fragment X on Query { scalar ...X }
    `);

    const { visitor } = analyze(ast, estimators());
    expect(visitor.complexity).to.equal(1);

    const spread = visitor.proofTree?.[0].children[0] as FragmentProofNode;
    expect(spread.fragmentName).to.equal('X');
    expect(spread.complexity).to.equal(1);
    const cyclic = spread.children[1] as FragmentProofNode;
    expect(cyclic.fragmentName).to.equal('X');
    expect(cyclic.cycle).to.equal(true);
    expect(cyclic.complexity).to.equal(0);
    expect(cyclic.contributesTo).to.deep.equal([]);
  });

  it('records directive decisions and keeps aliases in the response path', () => {
    const ast = parse(`
      query Foo($show: Boolean!, $skipIt: Boolean = false) {
        a: scalar @include(if: $show)
        b: scalar @skip(if: true)
        c: scalar @skip(if: $skipIt)
        d: scalar
      }
    `);

    const { visitor } = analyze(ast, estimators(), {
      variables: { show: true },
    });
    // a (included), c (not skipped) and d count, b is excluded
    expect(visitor.complexity).to.equal(3);

    const children = visitor.proofTree?.[0].children as FieldProofNode[];
    // Node order follows the document order
    expect(children.map((node) => node.responseName)).to.deep.equal([
      'a',
      'b',
      'c',
      'd',
    ]);

    // The alias enters the response path, the schema field identity stays
    expect(children[0].path).to.deep.equal(['a']);
    expect(children[0].responseName).to.equal('a');
    expect(children[0].fieldName).to.equal('scalar');
    expect(children[0].parentType).to.equal('Query');
    expect(children[0].included).to.equal(true);
    // Sensitive variables are only recorded as coercion type + summary
    expect(children[0].directives).to.deep.equal([
      {
        name: 'include',
        argument: { variable: 'show', type: 'Boolean!', summary: 1 },
        excluded: false,
      },
    ]);

    // Excluded by a literal @skip(if: true)
    expect(children[1].included).to.equal(false);
    expect(children[1].complexity).to.equal(0);
    expect(children[1].contributesTo).to.deep.equal([]);
    expect(children[1].directives).to.deep.equal([
      { name: 'skip', argument: true, excluded: true },
    ]);

    // Included because the variable default is false
    expect(children[2].included).to.equal(true);
    expect(children[2].directives).to.deep.equal([
      {
        name: 'skip',
        argument: { variable: 'skipIt', type: 'Boolean', summary: 0 },
        excluded: false,
      },
    ]);

    // No directives were evaluated for the last field
    expect(children[3].directives).to.equal(undefined);
  });

  it('records multiplier and non-sensitive summaries for list multiplier arrays', () => {
    const ast = parse(`
      query ($ids: [Int!]!) {
        listMultiplier(ids: $ids) {
          scalar
        }
      }
    `);

    const listEstimator: ComplexityEstimator = ({ args, childComplexity }) => {
      if (Array.isArray(args.ids)) {
        return args.ids.length * (1 + childComplexity);
      }
    };

    const { visitor } = analyze(
      ast,
      [listEstimator, simpleEstimator({ defaultComplexity: 1 })],
      { variables: { ids: [10, 20, 30] } }
    );
    expect(visitor.complexity).to.equal(6);

    const field = visitor.proofTree?.[0].children[0] as FieldProofNode;
    expect(field.fieldName).to.equal('listMultiplier');
    expect(field.fieldType).to.equal('[Item]');
    expect(field.estimatorIndex).to.equal(0);
    expect(field.childCost).to.equal(1);
    expect(field.complexity).to.equal(6);
    expect(field.ownCost).to.equal(5);
    expect(field.multiplier).to.equal(6);
    // Only the coercion type and a normalized numeric summary are recorded,
    // the raw input array is never echoed
    expect(field.args).to.deep.equal({
      ids: { type: '[Int!]!', summary: 3 },
    });
    expect(JSON.stringify(visitor.proofTree)).to.not.contain('[10,20,30]');
  });

  it('keeps concrete candidates and the max selection for union types', () => {
    const ast = parse(`
      query {
        union {
          ...on Item {
            scalar
            complexScalar
          }
          ...on SecondItem {
            scalar
          }
        }
      }
    `);

    const { visitor } = analyze(ast, estimators());
    const plain = getComplexity({
      estimators: estimators(),
      schema,
      query: ast,
    });
    expect(visitor.complexity).to.equal(22);
    expect(plain).to.equal(22);

    const field = visitor.proofTree?.[0].children[0] as FieldProofNode;
    expect(field.fieldName).to.equal('union');
    expect(field.fieldType).to.equal('Union');
    expect(field.childCost).to.equal(21);
    expect(field.complexity).to.equal(22);
    // All concrete candidates plus the rationale for selecting the maximum
    expect(field.candidates).to.deep.equal([
      { type: 'Item', complexity: 21 },
      { type: 'SecondItem', complexity: 1 },
    ]);
    expect(field.selectedType).to.equal('Item');
    // Inline fragments are recorded in document order
    expect(
      field.children.map((node) => (node as FragmentProofNode).typeCondition)
    ).to.deep.equal(['Item', 'SecondItem']);
    const itemFragment = field.children[0] as FragmentProofNode;
    expect(itemFragment.contributesTo).to.deep.equal(['Item']);
    expect(itemFragment.complexity).to.equal(21);
  });

  it('creates one proof root per evaluated operation in multi-operation documents', () => {
    const ast = parse(`
      query First {
        scalar
      }
      query Second {
        complexScalar
        scalar
      }
    `);

    // With operationName only that operation is evaluated
    let proof: OperationProofNode[] = [];
    const complexity = getComplexity({
      estimators: estimators(),
      schema,
      query: ast,
      operationName: 'Second',
      proofTree: true,
      onProofTree: (proofTree) => {
        proof = proofTree;
      },
    });
    expect(complexity).to.equal(21);
    expect(proof).to.have.length(1);
    expect(proof[0].name).to.equal('Second');
    expect(proof[0].complexity).to.equal(21);
    // Old API return value is identical with and without the proof tree
    expect(
      getComplexity({
        estimators: estimators(),
        schema,
        query: ast,
        operationName: 'Second',
      })
    ).to.equal(21);

    // Without operationName all operations are evaluated
    const { visitor } = analyze(ast, estimators());
    expect(visitor.complexity).to.equal(22);
    expect(visitor.proofTree?.map((node) => node.name)).to.deep.equal([
      'First',
      'Second',
    ]);
    expect(
      visitor.proofTree?.reduce((total, node) => total + node.complexity, 0)
    ).to.equal(22);
  });

  it('records the estimator hit and short-circuits later estimators', () => {
    const ast = parse(`
      query {
        scalar
      }
    `);

    const calls: string[] = [];
    const first: ComplexityEstimator = () => {
      calls.push('first');
      return 5;
    };
    const second: ComplexityEstimator = () => {
      calls.push('second');
      return 1;
    };
    const { visitor } = analyze(ast, [first, second]);
    expect(visitor.complexity).to.equal(5);
    // The second estimator was never invoked
    expect(calls).to.deep.equal(['first']);
    const field = visitor.proofTree?.[0].children[0] as FieldProofNode;
    expect(field.estimatorIndex).to.equal(0);
    expect(field.complexity).to.equal(5);

    // Falling through to the next estimator records its index
    const fallthroughCalls: string[] = [];
    const skip: ComplexityEstimator = () => {
      fallthroughCalls.push('skip');
    };
    const fallback: ComplexityEstimator = () => {
      fallthroughCalls.push('fallback');
      return 3;
    };
    const fallthrough = analyze(ast, [skip, fallback]);
    expect(fallthrough.visitor.complexity).to.equal(3);
    expect(fallthroughCalls).to.deep.equal(['skip', 'fallback']);
    const fallthroughField = fallthrough.visitor.proofTree?.[0]
      .children[0] as FieldProofNode;
    expect(fallthroughField.estimatorIndex).to.equal(1);
  });

  it('records error paths when no estimator returns a score', () => {
    const ast = parse(`
      query {
        list {
          scalar
        }
      }
    `);

    const noScore: ComplexityEstimator = () => undefined;
    const { context, visitor } = analyze(ast, [noScore]);
    expect(context.getErrors().length).to.equal(2);

    const operation = visitor.proofTree?.[0] as OperationProofNode;
    expect(operation.errors.map((error) => error.path)).to.deep.equal([
      ['list', 'scalar'],
      ['list'],
    ]);
    expect(operation.errors[0].message).to.match(
      /No complexity could be calculated for field Item\.scalar/
    );
    expect(operation.errors[1].message).to.match(
      /No complexity could be calculated for field Query\.list/
    );

    const listField = operation.children[0] as FieldProofNode;
    expect(listField.error).to.match(
      /No complexity could be calculated for field Query\.list/
    );
    expect(listField.estimatorIndex).to.equal(null);
    const scalarField = listField.children[0] as FieldProofNode;
    expect(scalarField.error).to.match(
      /No complexity could be calculated for field Item\.scalar/
    );
    expect(scalarField.estimatorIndex).to.equal(null);
  });

  it('does not allocate a proof tree when the option is disabled', () => {
    const ast = parse(`
      query {
        scalar
      }
    `);

    const { visitor } = analyze(ast, estimators(), { proofTree: false });
    expect(visitor.proofTree).to.equal(null);
    expect(visitor.complexity).to.equal(1);
  });
});
