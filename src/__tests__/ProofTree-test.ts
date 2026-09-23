/**
 * Tests for the optional complexity proof tree.
 */

import { parse, TypeInfo, visit, visitWithTypeInfo } from 'graphql';

import { expect } from 'chai';

import schema from './fixtures/schema.js';
import directiveSchema from '../estimators/directive/__tests__/fixtures/schema.js';

import ComplexityVisitor, {
  getComplexity,
  reduceProofTree,
  ComplexityEstimator,
  ComplexityProof,
  ComplexityFieldProof,
  ComplexityFragmentSpreadProof,
  ComplexityInlineFragmentProof,
  OperationProof,
} from '../QueryComplexity.js';
import {
  simpleEstimator,
  directiveEstimator,
  fieldExtensionsEstimator,
} from '../index.js';
import { CompatibleValidationContext } from './fixtures/CompatibleValidationContext.js';

describe('QueryComplexity proof tree', () => {
  const typeInfo = new TypeInfo(schema);

  function runWithProof(options: {
    estimators: ComplexityEstimator[];
    query: ReturnType<typeof parse>;
    variables?: Record<string, any>;
    operationName?: string;
    schema?: any;
  }): { complexity: number; proof: OperationProof } {
    let proof: OperationProof | undefined;
    const complexity = getComplexity({
      estimators: options.estimators,
      schema: options.schema ?? schema,
      query: options.query,
      variables: options.variables,
      operationName: options.operationName,
      proofTree: true,
      onComplete: (_complexity, operationProof) => {
        proof = operationProof;
      },
    });
    expect(proof).to.not.equal(undefined);
    return { complexity, proof: proof! };
  }

  function collectOrders(proof: ComplexityProof): number[] {
    const orders: number[] = [];
    const walk = (p: ComplexityProof): void => {
      for (const entry of p.entries) {
        orders.push(entry.order);
        if (
          (entry.kind === 'field' ||
            entry.kind === 'fragmentSpread' ||
            entry.kind === 'inlineFragment') &&
          entry.children
        ) {
          walk(entry.children);
        }
      }
    };
    walk(proof);
    return orders;
  }

  it('creates two occurrences for a fragment diamond (same fragment, two response paths)', () => {
    const ast = parse(`
      query {
        a: nonNullItem { ...F }
        b: nonNullItem { ...F }
      }
      fragment F on Item { scalar }
    `);

    const { complexity, proof } = runWithProof({
      estimators: [simpleEstimator({ defaultComplexity: 1 })],
      query: ast,
    });

    expect(complexity).to.equal(4);
    expect(proof.total).to.equal(4);
    // Total is strictly reduced from the tree
    expect(reduceProofTree(proof.root)).to.equal(4);

    expect(proof.root.parentType).to.equal('Query');
    expect(proof.root.abstract).to.equal(false);
    expect(proof.root.entries).to.have.length(2);

    const [a, b] = proof.root.entries as ComplexityFieldProof[];
    expect(a.kind).to.equal('field');
    // Alias enters the response path and response key
    expect(a.responseKey).to.equal('a');
    expect(a.path).to.deep.equal(['a']);
    // Schema field identity is not replaced by the alias
    expect(a.fieldName).to.equal('Query.nonNullItem');
    expect(a.ownCost).to.equal(1);
    expect(a.childCost).to.equal(1);
    expect(a.cost).to.equal(2);
    expect(a.multiplier).to.equal(1);

    expect(b.responseKey).to.equal('b');
    expect(b.path).to.deep.equal(['b']);
    expect(b.fieldName).to.equal('Query.nonNullItem');

    // Two separate occurrences of the same fragment F
    const spreadA = a.children!.entries[0] as ComplexityFragmentSpreadProof;
    const spreadB = b.children!.entries[0] as ComplexityFragmentSpreadProof;
    expect(spreadA.kind).to.equal('fragmentSpread');
    expect(spreadB.kind).to.equal('fragmentSpread');
    expect(spreadA).to.not.equal(spreadB);
    expect(spreadA.fragmentName).to.equal('F');
    expect(spreadB.fragmentName).to.equal('F');
    expect(spreadA.typeCondition).to.equal('Item');

    const scalarA = spreadA.children!.entries[0] as ComplexityFieldProof;
    const scalarB = spreadB.children!.entries[0] as ComplexityFieldProof;
    expect(scalarA.path).to.deep.equal(['a', 'scalar']);
    expect(scalarB.path).to.deep.equal(['b', 'scalar']);
    // Fragment origin is recorded on nodes inside the fragment
    expect(scalarA.fragment).to.deep.equal({
      name: 'F',
      typeCondition: 'Item',
    });
    expect(scalarB.fragment).to.deep.equal({
      name: 'F',
      typeCondition: 'Item',
    });

    // DFS pre-order indices are strictly increasing in traversal order
    expect(collectOrders(proof.root)).to.deep.equal([0, 1, 2, 3, 4, 5]);
    expect(a.order).to.equal(0);
    expect(spreadA.order).to.equal(1);
    expect(scalarA.order).to.equal(2);
    expect(b.order).to.equal(3);
    expect(spreadB.order).to.equal(4);
    expect(scalarB.order).to.equal(5);
  });

  it('blocks recursive fragment spreads via the traversal stack cycle guard', () => {
    const ast = parse(`
      query {
        ...A
      }
      fragment A on Query {
        scalar
        ...A
      }
    `);

    const { complexity, proof } = runWithProof({
      estimators: [simpleEstimator({ defaultComplexity: 1 })],
      query: ast,
    });

    expect(complexity).to.equal(1);
    expect(reduceProofTree(proof.root)).to.equal(1);

    const spread = proof.root.entries[0] as ComplexityFragmentSpreadProof;
    expect(spread.kind).to.equal('fragmentSpread');
    expect(spread.fragmentName).to.equal('A');
    expect(spread.cycle).to.not.equal(true);

    const [scalar, cycleSpread] = spread.children!.entries as [
      ComplexityFieldProof,
      ComplexityFragmentSpreadProof
    ];
    expect((scalar as ComplexityFieldProof).fieldName).to.equal('Query.scalar');
    expect(cycleSpread.kind).to.equal('fragmentSpread');
    expect(cycleSpread.cycle).to.equal(true);
    expect(cycleSpread.children).to.equal(undefined);
    expect(cycleSpread.appliesTo).to.deep.equal([]);
  });

  it('blocks mutually recursive fragments via the traversal stack', () => {
    const ast = parse(`
      query {
        ...A
      }
      fragment A on Query {
        scalar
        ...B
      }
      fragment B on Query {
        scalar
        ...A
      }
    `);

    const { complexity, proof } = runWithProof({
      estimators: [simpleEstimator({ defaultComplexity: 1 })],
      query: ast,
    });

    expect(complexity).to.equal(2);
    expect(reduceProofTree(proof.root)).to.equal(2);

    const spreadA = proof.root.entries[0] as ComplexityFragmentSpreadProof;
    const spreadB = spreadA.children!
      .entries[1] as ComplexityFragmentSpreadProof;
    expect(spreadB.fragmentName).to.equal('B');
    const backEdge = spreadB.children!
      .entries[1] as ComplexityFragmentSpreadProof;
    expect(backEdge.fragmentName).to.equal('A');
    expect(backEdge.cycle).to.equal(true);
  });

  it('records skip/include directive decisions and excluded nodes', () => {
    const ast = parse(`
      query Foo($show: Boolean!) {
        variableScalar(count: 10) @include(if: $show)
        scalar @skip(if: true)
        complexScalar @skip(if: false) @include(if: true)
        ...F @skip(if: true)
      }
      fragment F on Query {
        scalar
      }
    `);

    const estimators = () => [
      fieldExtensionsEstimator(),
      simpleEstimator({ defaultComplexity: 1 }),
    ];

    const excludedRun = runWithProof({
      estimators: estimators(),
      query: ast,
      variables: { show: false },
    });
    expect(excludedRun.complexity).to.equal(20);
    expect(reduceProofTree(excludedRun.proof.root)).to.equal(20);

    const [varScalar, scalar, complexScalar, spread] = excludedRun.proof.root
      .entries as [
      ComplexityFieldProof,
      ComplexityFieldProof,
      ComplexityFieldProof,
      ComplexityFragmentSpreadProof
    ];

    expect(varScalar.excluded).to.equal(true);
    expect(varScalar.directives).to.deep.equal([
      { name: 'include', included: false },
    ]);
    expect(varScalar.path).to.deep.equal(['variableScalar']);

    expect(scalar.excluded).to.equal(true);
    expect(scalar.directives).to.deep.equal([
      { name: 'skip', included: false },
    ]);

    expect(complexScalar.excluded).to.not.equal(true);
    expect(complexScalar.cost).to.equal(20);
    expect(complexScalar.directives).to.deep.equal([
      { name: 'skip', included: true },
      { name: 'include', included: true },
    ]);

    expect(spread.kind).to.equal('fragmentSpread');
    expect(spread.excluded).to.equal(true);
    expect(spread.typeCondition).to.equal('Query');

    // With $show = true the @include(if:) decision flips and the field counts
    const includedRun = runWithProof({
      estimators: estimators(),
      query: ast,
      variables: { show: true },
    });
    // variableScalar: 10 * 10 = 100 (fieldExtensions), complexScalar: 20
    expect(includedRun.complexity).to.equal(120);
    expect(reduceProofTree(includedRun.proof.root)).to.equal(120);
    const includedVarScalar = includedRun.proof.root
      .entries[0] as ComplexityFieldProof;
    expect(includedVarScalar.excluded).to.not.equal(true);
    expect(includedVarScalar.directives).to.deep.equal([
      { name: 'include', included: true },
    ]);
  });

  it('records list multiplier factors and redacted variable summaries', () => {
    const ast = parse(`
      query Q($ids: [ID]) {
        childList(ids: $ids, limit: 2) {
          scalar
        }
      }
    `);

    const { complexity, proof } = runWithProof({
      estimators: [directiveEstimator()],
      query: ast,
      variables: { ids: ['a', 'b', 'c'] },
      schema: directiveSchema,
    });

    // (value 3 + child 2) * (limit 2 * ids.length 3) = 30
    expect(complexity).to.equal(30);
    expect(reduceProofTree(proof.root)).to.equal(30);

    const childList = proof.root.entries[0] as ComplexityFieldProof;
    expect(childList.fieldName).to.equal('Query.childList');
    expect(childList.estimator).to.equal('directiveEstimator');
    expect(childList.estimatorIndex).to.equal(0);
    expect(childList.ownCost).to.equal(3);
    expect(childList.childCost).to.equal(2);
    expect(childList.multiplier).to.equal(6);
    expect(childList.cost).to.equal(30);

    const factors = childList.multiplierFactors!;
    expect(factors).to.have.length(2);
    expect(factors[0].path).to.equal('limit');
    expect(factors[0].value).to.equal(2);
    expect(factors[0].variable).to.equal(undefined);
    expect(factors[1].path).to.equal('ids');
    expect(factors[1].value).to.equal(3);
    expect(factors[1].variable).to.equal('ids');

    // Sensitive variable: only coercion type and normalized numeric summary
    expect(childList.variables).to.deep.equal([
      { name: 'ids', type: '[ID]', isList: true, arrayLength: 3 },
    ]);
    // Raw variable input values are never echoed into the proof
    const serialized = JSON.stringify(proof);
    expect(serialized).to.not.include('"a"');
    expect(serialized).to.not.include('"b"');
    expect(serialized).to.not.include('"c"');

    const scalar = childList.children!.entries[0] as ComplexityFieldProof;
    expect(scalar.fieldName).to.equal('ChildType.scalar');
    expect(scalar.cost).to.equal(2);
  });

  it('keeps concrete candidates and the max-selection rationale for unions', () => {
    const ast = parse(`
      query {
        union {
          ...on Item {
            scalar
            complexScalar
          }
        }
      }
    `);

    const { complexity, proof } = runWithProof({
      estimators: [
        fieldExtensionsEstimator(),
        simpleEstimator({ defaultComplexity: 1 }),
      ],
      query: ast,
    });

    expect(complexity).to.equal(22);
    expect(reduceProofTree(proof.root)).to.equal(22);

    const union = proof.root.entries[0] as ComplexityFieldProof;
    expect(union.fieldName).to.equal('Query.union');
    expect(union.ownCost).to.equal(1);
    expect(union.childCost).to.equal(21);

    const unionSet = union.children!;
    expect(unionSet.parentType).to.equal('Union');
    expect(unionSet.abstract).to.equal(true);
    // Concrete candidates with their totals, in schema definition order
    expect(unionSet.candidates).to.deep.equal([
      { type: 'Item', total: 21 },
      { type: 'SecondItem', total: 0 },
    ]);
    // The maximum candidate is selected, matching the numeric algorithm
    expect(unionSet.selectedType).to.equal('Item');
    expect(unionSet.total).to.equal(21);
    expect(unionSet.typeTotals).to.deep.equal({ Item: 21 });

    const inline = unionSet.entries[0] as ComplexityInlineFragmentProof;
    expect(inline.kind).to.equal('inlineFragment');
    expect(inline.typeCondition).to.equal('Item');
    expect(inline.appliesTo).to.deep.equal(['Item']);
  });

  it('creates one proof per operation for multi-operation documents', () => {
    const ast = parse(`
      query Primary {
        scalar
        complexScalar
      }

      query Secondary {
        complexScalar
      }
    `);

    const estimators = [
      fieldExtensionsEstimator(),
      simpleEstimator({ defaultComplexity: 1 }),
    ];

    // Old API return values are unchanged when the proof tree is enabled
    const complexityAll = getComplexity({
      estimators,
      schema,
      query: ast,
      proofTree: true,
    });
    expect(complexityAll).to.equal(41);

    const context = new CompatibleValidationContext(schema, ast, typeInfo);
    const completed: Array<[number, OperationProof | undefined]> = [];
    const visitor = new ComplexityVisitor(context, {
      maximumComplexity: 1000,
      estimators,
      proofTree: true,
      onComplete: (complexity, proof) => completed.push([complexity, proof]),
    });
    visit(ast, visitWithTypeInfo(typeInfo, visitor));

    expect(visitor.complexity).to.equal(41);
    expect(visitor.proofs).to.have.length(2);
    expect(visitor.proofs[0].operation).to.equal('Primary');
    expect(visitor.proofs[0].total).to.equal(21);
    expect(reduceProofTree(visitor.proofs[0].root)).to.equal(21);
    expect(visitor.proofs[1].operation).to.equal('Secondary');
    expect(visitor.proofs[1].total).to.equal(20);
    expect(reduceProofTree(visitor.proofs[1].root)).to.equal(20);
    // onComplete receives the cumulative complexity and the operation proof
    expect(completed).to.have.length(2);
    expect(completed[0][0]).to.equal(21);
    expect(completed[0][1]!.operation).to.equal('Primary');
    expect(completed[1][0]).to.equal(41);
    expect(completed[1][1]!.operation).to.equal('Secondary');

    // Only the selected operation is analyzed when operationName is given
    const { complexity, proof } = runWithProof({
      estimators,
      query: ast,
      operationName: 'Secondary',
    });
    expect(complexity).to.equal(20);
    expect(proof.operation).to.equal('Secondary');
    expect(reduceProofTree(proof.root)).to.equal(20);
  });

  it('records the estimator short-circuit (first matching estimator wins)', () => {
    const ast = parse(`
      query {
        scalar
      }
    `);

    let decliningCalls = 0;
    let neverCalls = 0;
    const decliningEstimator: ComplexityEstimator = () => {
      decliningCalls++;
      return undefined;
    };
    function winningEstimator(): number {
      return 5;
    }
    const neverEstimator: ComplexityEstimator = () => {
      neverCalls++;
      return 100;
    };

    const { complexity, proof } = runWithProof({
      estimators: [decliningEstimator, winningEstimator, neverEstimator],
      query: ast,
    });

    expect(complexity).to.equal(5);
    expect(reduceProofTree(proof.root)).to.equal(5);
    expect(decliningCalls).to.equal(1);
    // Estimators after the first match are never invoked
    expect(neverCalls).to.equal(0);

    const scalar = proof.root.entries[0] as ComplexityFieldProof;
    expect(scalar.estimatorIndex).to.equal(1);
    expect(scalar.estimator).to.equal('winningEstimator');
    expect(scalar.cost).to.equal(5);
    // Legacy numeric estimators are normalized: ownCost reconciles with cost
    expect(scalar.ownCost).to.equal(5);
    expect(scalar.childCost).to.equal(0);
    expect(scalar.multiplier).to.equal(1);
  });

  it('records the error path when no estimator returns a score', () => {
    const ast = parse(`
      query {
        scalar
      }
    `);

    const context = new CompatibleValidationContext(schema, ast, typeInfo);
    const visitor = new ComplexityVisitor(context, {
      maximumComplexity: 100,
      estimators: [fieldExtensionsEstimator()],
      proofTree: true,
    });
    visit(ast, visitWithTypeInfo(typeInfo, visitor));

    // Old error reporting behavior is unchanged
    expect(context.getErrors().length).to.equal(1);
    expect(context.getErrors()[0].message).to.equal(
      'No complexity could be calculated for field Query.scalar. ' +
        'At least one complexity estimator has to return a complexity score.'
    );
    expect(visitor.complexity).to.equal(0);

    const scalar = visitor.proofs[0].root.entries[0] as ComplexityFieldProof;
    expect(scalar.shortCircuited).to.equal(true);
    expect(scalar.errors).to.have.length(1);
    expect(scalar.errors![0].message).to.equal(
      'No complexity could be calculated for field Query.scalar. ' +
        'At least one complexity estimator has to return a complexity score.'
    );
    expect(scalar.errors![0].path).to.deep.equal(['scalar']);
    expect(reduceProofTree(visitor.proofs[0].root)).to.equal(0);
  });

  it('records the error path for invalid argument coercion', () => {
    const ast = parse(`
      query {
        requiredArgs
      }
    `);

    const context = new CompatibleValidationContext(schema, ast, typeInfo);
    const visitor = new ComplexityVisitor(context, {
      maximumComplexity: 100,
      estimators: [simpleEstimator({ defaultComplexity: 1 })],
      proofTree: true,
    });
    visit(ast, visitWithTypeInfo(typeInfo, visitor));

    expect(context.getErrors().length).to.equal(1);
    expect(context.getErrors()[0].message).to.match(
      /required type "Int!" was not provided/
    );

    const requiredArgs = visitor.proofs[0].root
      .entries[0] as ComplexityFieldProof;
    expect(requiredArgs.errors).to.have.length(1);
    expect(requiredArgs.errors![0].path).to.deep.equal(['requiredArgs']);
    expect(requiredArgs.errors![0].field).to.equal('Query.requiredArgs');
    expect(requiredArgs.errors![0].message).to.match(
      /required type "Int!" was not provided/
    );
    expect(reduceProofTree(visitor.proofs[0].root)).to.equal(0);
  });

  it('attaches the response path to max node errors when proof is enabled', () => {
    const ast = parse(`
      query {
        nonNullItem {
          scalar
          scalar2: scalar
        }
      }
    `);

    expect(() =>
      getComplexity({
        estimators: [simpleEstimator({ defaultComplexity: 1 })],
        schema,
        query: ast,
        maxQueryNodes: 2,
        proofTree: true,
      })
    )
      .to.throw('Query exceeds the maximum allowed number of nodes.')
      .with.property('path')
      .that.deep.equals(['nonNullItem']);

    // Message stays identical when the proof tree is disabled
    expect(() =>
      getComplexity({
        estimators: [simpleEstimator({ defaultComplexity: 1 })],
        schema,
        query: ast,
        maxQueryNodes: 2,
      })
    ).to.throw('Query exceeds the maximum allowed number of nodes.');
  });

  it('does not allocate proof state when the proof tree is disabled', () => {
    const ast = parse(`
      query {
        scalar
        nonNullItem {
          scalar
        }
      }
    `);

    const context = new CompatibleValidationContext(schema, ast, typeInfo);
    const completed: Array<[number, OperationProof | undefined]> = [];
    const visitor = new ComplexityVisitor(context, {
      maximumComplexity: 100,
      estimators: [simpleEstimator({ defaultComplexity: 1 })],
      onComplete: (complexity, proof) => completed.push([complexity, proof]),
    });
    visit(ast, visitWithTypeInfo(typeInfo, visitor));

    expect(visitor.complexity).to.equal(3);
    expect(visitor.proofs).to.deep.equal([]);
    expect(completed).to.have.length(1);
    expect(completed[0][0]).to.equal(3);
    expect(completed[0][1]).to.equal(undefined);
  });

  it('produces identical totals with and without the proof tree (old API unchanged)', () => {
    const cases: Array<{
      query: string;
      variables?: Record<string, any>;
      operationName?: string;
      estimators: ComplexityEstimator[];
      expected: number;
    }> = [
      {
        query: `query { variableScalar(count: 10) }`,
        estimators: [simpleEstimator({ defaultComplexity: 1 })],
        expected: 1,
      },
      {
        query: `query Q($count: Int) { variableScalar(count: $count) }`,
        variables: { count: 5 },
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
        expected: 50,
      },
      {
        query: `query { union { ...on Item { scalar complexScalar } } }`,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
        expected: 22,
      },
      {
        query: `query { interface { name ...on NameInterface { name } } }`,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
        expected: 3,
      },
      {
        query: `
          query {
            scalar
            ...QueryFragment
          }
          fragment QueryFragment on Query {
            variableScalar(count: 2)
          }
        `,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
        expected: 21,
      },
      {
        query: `
          query Primary { scalar complexScalar }
          query Secondary { complexScalar }
        `,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
        expected: 41,
      },
      {
        query: `
          query Primary { scalar complexScalar }
          query Secondary { complexScalar }
        `,
        operationName: 'Secondary',
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
        expected: 20,
      },
    ];

    for (const testCase of cases) {
      const ast = parse(testCase.query);
      const withoutProof = getComplexity({
        estimators: testCase.estimators,
        schema,
        query: ast,
        variables: testCase.variables,
        operationName: testCase.operationName,
      });
      const proofs: OperationProof[] = [];
      const withProof = getComplexity({
        estimators: testCase.estimators,
        schema,
        query: ast,
        variables: testCase.variables,
        operationName: testCase.operationName,
        proofTree: true,
        onComplete: (_complexity, operationProof) => {
          if (operationProof) {
            proofs.push(operationProof);
          }
        },
      });
      // Old API return value is item-by-item identical
      expect(withProof).to.equal(testCase.expected);
      expect(withoutProof).to.equal(testCase.expected);
      // The proof trees strictly reduce to the same total
      expect(proofs.length).to.be.greaterThan(0);
      const reducedTotal = proofs.reduce(
        (sum, operationProof) => sum + reduceProofTree(operationProof.root),
        0
      );
      expect(reducedTotal).to.equal(testCase.expected);
    }
  });
});
