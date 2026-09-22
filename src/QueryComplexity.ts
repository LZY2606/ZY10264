/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * Created by Ivo Meißner on 28.07.17.
 */

import {
  getArgumentValues,
  getDirectiveValues,
  getVariableValues,
  ValidationContext,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  VariableDefinitionNode,
  DirectiveNode,
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  GraphQLField,
  GraphQLArgument,
  isCompositeType,
  GraphQLCompositeType,
  GraphQLFieldMap,
  GraphQLSchema,
  DocumentNode,
  TypeInfo,
  visit,
  visitWithTypeInfo,
  GraphQLDirective,
  isAbstractType,
  GraphQLNamedType,
  GraphQLUnionType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  getNamedType,
  GraphQLError,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
  print,
} from 'graphql';

export type ComplexityEstimatorArgs = {
  type: GraphQLCompositeType;
  field: GraphQLField<any, any>;
  node: FieldNode;
  args: { [key: string]: any };
  childComplexity: number;
  context?: Record<string, any>;
};

export type ComplexityEstimator = (
  options: ComplexityEstimatorArgs
) => number | void;

// Complexity can be anything that is supported by the configured estimators
export type Complexity = any;

// Map of complexities for possible types (of Union, Interface types)
type ComplexityMap = {
  [typeName: string]: number;
};

/**
 * Normalized, non-sensitive summary of a variable value that was used during
 * coercion. Only the type the value was coerced against and a normalized
 * numeric summary are recorded, never the raw input value.
 */
export type ProofVariableSummary = {
  // Name of the query variable (without leading "$")
  variable: string;
  // Printed type the variable was coerced with (e.g. "Int", "[ID!]!")
  type: string;
  // Normalized numeric summary of the value (see numericSummary)
  summary: number | null;
};

// Non-sensitive summary of a field argument value
export type ProofArgumentSummary = {
  // Printed declared argument type used for coercion
  type: string;
  // Normalized numeric summary of the coerced value
  summary: number | null;
};

// Record of a directive evaluation that influenced a proof node
export type ProofDirectiveDecision = {
  // Directive name (e.g. "include" / "skip")
  name: string;
  // Evaluated `if` argument: a boolean for literals, a normalized summary
  // for variable references (raw variable values are never echoed)
  argument?: boolean | ProofVariableSummary;
  // Whether this directive excluded the node from the estimation
  excluded: boolean;
};

// Complexity of one concrete (object) type candidate of an abstract type
export type ProofCandidate = {
  type: string;
  complexity: number;
};

// An error that occurred while estimating a specific node
export type ProofError = {
  path: string[];
  message: string;
};

type ProofNodeBase = {
  // Response path of this node (aliases applied, fragments add a segment)
  path: string[];
  // Whether the node was included after directive evaluation
  included: boolean;
  // Directive decisions that were evaluated for this node
  directives?: ProofDirectiveDecision[];
  // Names of the possible parent types this node contributes complexity to
  contributesTo: string[];
  // Reduced complexity of this node (0 for excluded/ignored nodes)
  complexity: number;
  children: ProofNode[];
  // Reason the node was ignored (e.g. unknown field/fragment), if any
  ignored?: string;
};

export type FieldProofNode = ProofNodeBase & {
  kind: 'Field';
  // Response name (alias if present, otherwise the field name)
  responseName: string;
  // Schema field name. The schema field identity is never replaced by an alias
  fieldName: string;
  // Name of the parent composite type
  parentType: string;
  // Printed field type, if the field could be resolved in the schema
  fieldType?: string;
  // Index of the estimator that produced the score (estimator hit),
  // null if no estimator returned a valid score
  estimatorIndex: number | null;
  // Own cost: the part of the estimator score added on top of the child cost
  ownCost: number;
  // Complexity of the child selection set the estimator received
  childCost: number;
  // Derived multiplier: score / childCost (1 if childCost is 0)
  multiplier: number;
  // Non-sensitive summaries of the evaluated arguments
  args?: Record<string, ProofArgumentSummary>;
  // Concrete type candidates + selection rationale for abstract field types
  candidates?: ProofCandidate[];
  selectedType?: string | null;
  // Error message if estimation failed for this field
  error?: string;
};

export type FragmentProofNode = ProofNodeBase & {
  kind: 'FragmentSpread' | 'InlineFragment';
  // Origin fragment name for spreads (fragment source of this occurrence)
  fragmentName?: string;
  // Type condition of the fragment, if present/known
  typeCondition?: string;
  // Concrete type candidates of the fragment type and the max selection
  candidates: ProofCandidate[];
  selectedType: string | null;
  // True if the cycle guard stopped this occurrence (traversal stack based)
  cycle?: boolean;
};

export type ProofNode = FieldProofNode | FragmentProofNode;

export type OperationProofNode = {
  kind: 'OperationDefinition';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  path: string[];
  complexity: number;
  candidates: ProofCandidate[];
  selectedType: string | null;
  children: ProofNode[];
  errors: ProofError[];
};

export interface QueryComplexityOptions {
  // The maximum allowed query complexity, queries above this threshold will be rejected
  maximumComplexity: number;

  // The query variables. This is needed because the variables are not available
  // in the visitor of the graphql-js library
  variables?: Record<string, any>;

  // specify operation name only when pass multi-operation documents
  operationName?: string;

  // Optional callback function to retrieve the determined query complexity
  // Will be invoked whether the query is rejected or not
  // This can be used for logging or to implement rate limiting
  onComplete?: (complexity: number) => void;

  // Optional function to create a custom error
  createError?: (max: number, actual: number) => GraphQLError;

  // An array of complexity estimators to use for estimating the complexity
  estimators: Array<ComplexityEstimator>;

  // Pass request context to the estimators via estimationContext
  context?: Record<string, any>;

  // The maximum number of nodes to evaluate. If this is set, the query will be
  // rejected if it exceeds this number. (Includes fields, fragments, inline fragments, etc.)
  // Defaults to 10_000.
  maxQueryNodes?: number;

  // Collect a proof tree explaining how the complexity was calculated.
  // The tree is built during the same traversal as the numeric estimation and
  // the total complexity is strictly reduced from it. When disabled (default),
  // no persistent allocations are made. The collected tree is available on the
  // `proofTree` property of the visitor.
  proofTree?: boolean;
}

function queryComplexityMessage(max: number, actual: number): string {
  return (
    `The query exceeds the maximum complexity of ${max}. ` +
    `Actual complexity is ${actual}`
  );
}

export function getComplexity(options: {
  estimators: ComplexityEstimator[];
  schema: GraphQLSchema;
  query: DocumentNode;
  variables?: Record<string, any>;
  operationName?: string;
  context?: Record<string, any>;
  maxQueryNodes?: number;
  proofTree?: boolean;
  onProofTree?: (proofTree: OperationProofNode[]) => void;
}): number {
  const typeInfo = new TypeInfo(options.schema);

  const errors: GraphQLError[] = [];
  const context = new ValidationContext(
    options.schema,
    options.query,
    typeInfo,
    (error) => errors.push(error)
  );
  const visitor = new QueryComplexity(context, {
    // Maximum complexity does not matter since we're only interested in the calculated complexity.
    maximumComplexity: Infinity,
    estimators: options.estimators,
    variables: options.variables,
    operationName: options.operationName,
    context: options.context,
    maxQueryNodes: options.maxQueryNodes,
    proofTree: options.proofTree,
  });

  visit(options.query, visitWithTypeInfo(typeInfo, visitor));

  // Throw first error if any
  if (errors.length) {
    throw errors.pop();
  }

  if (options.onProofTree) {
    options.onProofTree(visitor.proofTree ?? []);
  }

  return visitor.complexity;
}

export default class QueryComplexity {
  context: ValidationContext;
  complexity: number;
  options: QueryComplexityOptions;
  OperationDefinition: Record<string, any>;
  estimators: Array<ComplexityEstimator>;
  includeDirectiveDef: GraphQLDirective;
  skipDirectiveDef: GraphQLDirective;
  variableValues: Record<string, any>;
  requestContext?: Record<string, any>;
  evaluatedNodes: number;
  maxQueryNodes: number;
  proofTree: OperationProofNode[] | null;
  variableTypes: Record<string, string>;
  currentOperationProof: OperationProofNode | null;

  constructor(context: ValidationContext, options: QueryComplexityOptions) {
    if (
      !(
        typeof options.maximumComplexity === 'number' &&
        options.maximumComplexity > 0
      )
    ) {
      throw new Error('Maximum query complexity must be a positive number');
    }

    this.context = context;
    this.complexity = 0;
    this.options = options;
    this.evaluatedNodes = 0;
    this.maxQueryNodes = options.maxQueryNodes ?? 10_000;
    this.includeDirectiveDef = this.context.getSchema().getDirective('include');
    this.skipDirectiveDef = this.context.getSchema().getDirective('skip');
    this.estimators = options.estimators;
    this.variableValues = {};
    this.requestContext = options.context;
    this.proofTree = options.proofTree ? [] : null;
    this.variableTypes = {};
    this.currentOperationProof = null;

    this.OperationDefinition = {
      enter: this.onOperationDefinitionEnter,
      leave: this.onOperationDefinitionLeave,
    };
  }

  onOperationDefinitionEnter(operation: OperationDefinitionNode): void {
    if (
      typeof this.options.operationName === 'string' &&
      this.options.operationName !== operation.name.value
    ) {
      return;
    }

    // Get variable values from variables that are passed from options, merged
    // with default values defined in the operation
    const { variableValues, errors } = getOperationVariableValues(
      this.context.getSchema(),
      // We have to create a new array here because input argument is not readonly in graphql ~14.6.0
      operation.variableDefinitions ? [...operation.variableDefinitions] : [],
      this.options.variables ?? {}
    );
    if (errors && errors.length) {
      // We have input validation errors, report errors and abort
      errors.forEach((error) => this.context.reportError(error));
      return;
    }
    this.variableValues = variableValues;

    // Remember the types variables are coerced with so proof nodes can record
    // non-sensitive summaries instead of raw variable values
    this.variableTypes = {};
    for (const variableDefinition of operation.variableDefinitions ?? []) {
      this.variableTypes[variableDefinition.variable.name.value] = print(
        variableDefinition.type
      );
    }

    let rootType: GraphQLObjectType | undefined;
    switch (operation.operation) {
      case 'query':
        rootType = this.context.getSchema().getQueryType();
        break;
      case 'mutation':
        rootType = this.context.getSchema().getMutationType();
        break;
      case 'subscription':
        rootType = this.context.getSchema().getSubscriptionType();
        break;
      default:
        throw new Error(
          `Query complexity could not be calculated for operation of type ${operation.operation}`
        );
    }

    let operationProof: OperationProofNode | null = null;
    if (this.proofTree) {
      operationProof = {
        kind: 'OperationDefinition',
        operation: operation.operation,
        path: [],
        complexity: 0,
        candidates: [],
        selectedType: null,
        children: [],
        errors: [],
      };
      if (operation.name) {
        operationProof.name = operation.name.value;
      }
      this.proofTree.push(operationProof);
    }
    this.currentOperationProof = operationProof;

    const operationComplexity = this.nodeComplexity(
      operation,
      rootType,
      new Set(),
      [],
      operationProof ? operationProof.children : undefined
    );

    if (operationProof) {
      // The total is strictly reduced from the proof tree
      const reduction = reduceProofChildren(
        operationProof.children,
        rootType ? [rootType.name] : []
      );
      operationProof.candidates = reduction.candidates;
      operationProof.selectedType = reduction.selectedType;
      operationProof.complexity = reduction.complexity;
    }
    this.complexity += operationComplexity;
    this.currentOperationProof = null;
  }

  onOperationDefinitionLeave(
    operation: OperationDefinitionNode
  ): GraphQLError | void {
    if (
      typeof this.options.operationName === 'string' &&
      this.options.operationName !== operation.name.value
    ) {
      return;
    }

    if (this.options.onComplete) {
      this.options.onComplete(this.complexity);
    }

    if (this.complexity > this.options.maximumComplexity) {
      return this.context.reportError(this.createError());
    }
  }

  nodeComplexity(
    node:
      | FieldNode
      | FragmentDefinitionNode
      | InlineFragmentNode
      | OperationDefinitionNode,
    typeDef:
      | GraphQLObjectType
      | GraphQLInterfaceType
      | GraphQLUnionType
      | undefined,
    activeFragments: Set<string> = new Set(),
    path: string[] = [],
    proofChildren?: ProofNode[]
  ): number {
    if (node.selectionSet && typeDef) {
      let fields: GraphQLFieldMap<any, any> = {};
      if (
        typeDef instanceof GraphQLObjectType ||
        typeDef instanceof GraphQLInterfaceType
      ) {
        fields = typeDef.getFields();
      }

      // Determine all possible types of the current node
      const possibleTypeNames = this.possibleTypeNames(typeDef);

      // Collect complexities for all possible types individually
      const selectionSetComplexities: ComplexityMap =
        node.selectionSet.selections.reduce(
          (
            complexities: ComplexityMap,
            childNode: FieldNode | FragmentSpreadNode | InlineFragmentNode
          ): ComplexityMap => {
            this.evaluatedNodes++;
            if (this.evaluatedNodes >= this.maxQueryNodes) {
              throw new GraphQLError(
                'Query exceeds the maximum allowed number of nodes.'
              );
            }
            let innerComplexities = complexities;

            let includeNode = true;
            let skipNode = false;

            // Directive decisions are only recorded when the proof tree is
            // enabled, otherwise no allocations are made
            const proofDirectives: ProofDirectiveDecision[] | undefined =
              proofChildren ? [] : undefined;

            for (const directive of childNode.directives ?? []) {
              const directiveName = directive.name.value;
              switch (directiveName) {
                case 'include': {
                  const values = getDirectiveValues(
                    this.includeDirectiveDef,
                    childNode,
                    getExecutionVariableValues(this.variableValues)
                  );
                  if (typeof values.if === 'boolean') {
                    includeNode = values.if;
                    proofDirectives?.push({
                      name: 'include',
                      argument: this.summarizeDirectiveArgument(
                        directive,
                        values.if
                      ),
                      excluded: !values.if,
                    });
                  }
                  break;
                }
                case 'skip': {
                  const values = getDirectiveValues(
                    this.skipDirectiveDef,
                    childNode,
                    getExecutionVariableValues(this.variableValues)
                  );
                  if (typeof values.if === 'boolean') {
                    skipNode = values.if;
                    proofDirectives?.push({
                      name: 'skip',
                      argument: this.summarizeDirectiveArgument(
                        directive,
                        values.if
                      ),
                      excluded: values.if,
                    });
                  }
                  break;
                }
              }
            }

            if (!includeNode || skipNode) {
              if (proofChildren) {
                proofChildren.push(
                  this.buildExcludedProofNode(
                    childNode,
                    typeDef,
                    fields,
                    path,
                    proofDirectives ?? []
                  )
                );
              }
              return complexities;
            }

            switch (childNode.kind) {
              case 'Field': {
                const field = resolveField(fields, childNode.name.value);

                // The alias enters the response path, the schema field
                // identity (fieldName) is not replaced by the alias
                const responseName = childNode.alias
                  ? childNode.alias.value
                  : childNode.name.value;
                const fieldPath = [...path, responseName];

                // Invalid field, should be caught by other validation rules
                if (!field) {
                  if (proofChildren) {
                    proofChildren.push({
                      kind: 'Field',
                      path: fieldPath,
                      responseName,
                      fieldName: childNode.name.value,
                      parentType: typeDef.name,
                      included: true,
                      directives: nonEmptyDirectives(proofDirectives),
                      contributesTo: [],
                      estimatorIndex: null,
                      ownCost: 0,
                      childCost: 0,
                      multiplier: 1,
                      complexity: 0,
                      children: [],
                      ignored: 'Unknown field',
                    });
                  }
                  break;
                }
                const fieldType = getNamedType(field.type);

                let fieldProof: FieldProofNode | undefined;
                if (proofChildren) {
                  fieldProof = {
                    kind: 'Field',
                    path: fieldPath,
                    responseName,
                    fieldName: field.name,
                    parentType: typeDef.name,
                    fieldType: String(field.type),
                    included: true,
                    directives: nonEmptyDirectives(proofDirectives),
                    contributesTo: possibleTypeNames,
                    estimatorIndex: null,
                    ownCost: 0,
                    childCost: 0,
                    multiplier: 1,
                    complexity: 0,
                    children: [],
                  };
                  proofChildren.push(fieldProof);
                }

                // Get arguments
                let args: { [key: string]: any };
                try {
                  args = getArgumentValues(
                    field,
                    childNode,
                    getExecutionVariableValues(this.variableValues)
                  );
                } catch (e) {
                  if (fieldProof) {
                    fieldProof.error = e.message;
                    this.currentOperationProof?.errors.push({
                      path: fieldPath,
                      message: e.message,
                    });
                  }
                  this.context.reportError(e);
                  return complexities;
                }

                if (fieldProof) {
                  const argSummaries = summarizeArguments(field.args, args);
                  if (Object.keys(argSummaries).length) {
                    fieldProof.args = argSummaries;
                  }
                }

                // Check if we have child complexity
                let childComplexity = 0;
                if (isCompositeType(fieldType)) {
                  childComplexity = this.nodeComplexity(
                    childNode,
                    fieldType,
                    activeFragments,
                    fieldPath,
                    fieldProof ? fieldProof.children : undefined
                  );
                }

                if (fieldProof && isCompositeType(fieldType)) {
                  // Keep all concrete candidates of interface/union field
                  // types plus the rationale for selecting the maximum
                  const reduction = reduceProofChildren(
                    fieldProof.children,
                    this.possibleTypeNames(fieldType)
                  );
                  fieldProof.candidates = reduction.candidates;
                  fieldProof.selectedType = reduction.selectedType;
                }

                // Run estimators one after another and return first valid complexity
                // score
                const estimatorArgs: ComplexityEstimatorArgs = {
                  childComplexity,
                  args,
                  field,
                  node: childNode,
                  type: typeDef,
                  context: this.requestContext,
                };
                let estimatorIndex = -1;
                let score = 0;
                const validScore = this.estimators.find((estimator, index) => {
                  const tmpComplexity = estimator(estimatorArgs);

                  if (
                    typeof tmpComplexity === 'number' &&
                    !isNaN(tmpComplexity)
                  ) {
                    estimatorIndex = index;
                    score = tmpComplexity;
                    innerComplexities = addComplexities(
                      tmpComplexity,
                      complexities,
                      possibleTypeNames
                    );
                    return true;
                  }

                  return false;
                });
                if (!validScore) {
                  const error = new GraphQLError(
                    `No complexity could be calculated for field ${typeDef.name}.${field.name}. ` +
                      'At least one complexity estimator has to return a complexity score.'
                  );
                  if (fieldProof) {
                    fieldProof.error = error.message;
                    this.currentOperationProof?.errors.push({
                      path: fieldPath,
                      message: error.message,
                    });
                  }
                  this.context.reportError(error);
                  return complexities;
                }
                if (fieldProof) {
                  fieldProof.estimatorIndex = estimatorIndex;
                  fieldProof.complexity = score;
                  fieldProof.childCost = childComplexity;
                  fieldProof.ownCost = score - childComplexity;
                  fieldProof.multiplier =
                    childComplexity !== 0 ? score / childComplexity : 1;
                }
                break;
              }
              case 'FragmentSpread': {
                const fragmentName = childNode.name.value;
                const fragmentPath = [...path, `...${fragmentName}`];
                let spreadProof: FragmentProofNode | undefined;
                if (proofChildren) {
                  spreadProof = {
                    kind: 'FragmentSpread',
                    path: fragmentPath,
                    fragmentName,
                    included: true,
                    directives: nonEmptyDirectives(proofDirectives),
                    contributesTo: [],
                    complexity: 0,
                    candidates: [],
                    selectedType: null,
                    children: [],
                  };
                  proofChildren.push(spreadProof);
                }
                const fragment = this.context.getFragment(fragmentName);
                // Unknown fragment, should be caught by other validation rules
                if (!fragment) {
                  if (spreadProof) {
                    spreadProof.ignored = 'Unknown fragment';
                  }
                  break;
                }
                // Circular fragment reference — skip to avoid infinite recursion
                if (activeFragments.has(fragmentName)) {
                  if (spreadProof) {
                    // The cycle guard blocks this occurrence based on the
                    // current traversal stack
                    spreadProof.cycle = true;
                  }
                  break;
                }
                const fragmentType = this.context
                  .getSchema()
                  .getType(fragment.typeCondition.name.value);
                // Invalid fragment type, ignore. Should be caught by other validation rules
                if (!isCompositeType(fragmentType)) {
                  if (spreadProof) {
                    spreadProof.ignored = 'Invalid type condition';
                  }
                  break;
                }
                if (spreadProof) {
                  spreadProof.typeCondition = fragment.typeCondition.name.value;
                }
                // Track this fragment on the active path so deeper spreads can
                // detect cycles, then remove it on the way back up (backtracking)
                // to avoid copying the set on every descent.
                activeFragments.add(fragmentName);
                const nodeComplexity = this.nodeComplexity(
                  fragment,
                  fragmentType,
                  activeFragments,
                  fragmentPath,
                  spreadProof ? spreadProof.children : undefined
                );
                activeFragments.delete(fragmentName);
                const fragmentPossibleTypeNames = isAbstractType(fragmentType)
                  ? this.context
                      .getSchema()
                      .getPossibleTypes(fragmentType)
                      .map((t) => t.name)
                  : [fragmentType.name];
                if (spreadProof) {
                  spreadProof.contributesTo = fragmentPossibleTypeNames;
                  const reduction = reduceProofChildren(
                    spreadProof.children,
                    fragmentPossibleTypeNames
                  );
                  spreadProof.candidates = reduction.candidates;
                  spreadProof.selectedType = reduction.selectedType;
                  spreadProof.complexity = reduction.complexity;
                }
                if (isAbstractType(fragmentType)) {
                  // Add fragment complexity for all possible types
                  innerComplexities = addComplexities(
                    nodeComplexity,
                    complexities,
                    fragmentPossibleTypeNames
                  );
                } else {
                  // Add complexity for object type
                  innerComplexities = addComplexities(
                    nodeComplexity,
                    complexities,
                    fragmentPossibleTypeNames
                  );
                }
                break;
              }
              case 'InlineFragment': {
                let inlineFragmentType: GraphQLNamedType = typeDef;
                const fragmentSegment = childNode.typeCondition
                  ? `... on ${childNode.typeCondition.name.value}`
                  : '...';
                const fragmentPath = [...path, fragmentSegment];
                if (childNode.typeCondition && childNode.typeCondition.name) {
                  inlineFragmentType = this.context
                    .getSchema()
                    .getType(childNode.typeCondition.name.value);
                  if (!isCompositeType(inlineFragmentType)) {
                    if (proofChildren) {
                      proofChildren.push({
                        kind: 'InlineFragment',
                        path: fragmentPath,
                        typeCondition: childNode.typeCondition.name.value,
                        included: true,
                        directives: nonEmptyDirectives(proofDirectives),
                        contributesTo: [],
                        complexity: 0,
                        candidates: [],
                        selectedType: null,
                        children: [],
                        ignored: 'Invalid type condition',
                      });
                    }
                    break;
                  }
                }

                let inlineProof: FragmentProofNode | undefined;
                if (proofChildren) {
                  inlineProof = {
                    kind: 'InlineFragment',
                    path: fragmentPath,
                    included: true,
                    directives: nonEmptyDirectives(proofDirectives),
                    contributesTo: [],
                    complexity: 0,
                    candidates: [],
                    selectedType: null,
                    children: [],
                  };
                  if (childNode.typeCondition) {
                    inlineProof.typeCondition =
                      childNode.typeCondition.name.value;
                  }
                  proofChildren.push(inlineProof);
                }

                const nodeComplexity = this.nodeComplexity(
                  childNode,
                  inlineFragmentType,
                  activeFragments,
                  fragmentPath,
                  inlineProof ? inlineProof.children : undefined
                );
                const inlinePossibleTypeNames = isAbstractType(
                  inlineFragmentType
                )
                  ? this.context
                      .getSchema()
                      .getPossibleTypes(inlineFragmentType)
                      .map((t) => t.name)
                  : [inlineFragmentType.name];
                if (inlineProof) {
                  inlineProof.contributesTo = inlinePossibleTypeNames;
                  const reduction = reduceProofChildren(
                    inlineProof.children,
                    inlinePossibleTypeNames
                  );
                  inlineProof.candidates = reduction.candidates;
                  inlineProof.selectedType = reduction.selectedType;
                  inlineProof.complexity = reduction.complexity;
                }
                if (isAbstractType(inlineFragmentType)) {
                  // Add fragment complexity for all possible types
                  innerComplexities = addComplexities(
                    nodeComplexity,
                    complexities,
                    inlinePossibleTypeNames
                  );
                } else {
                  // Add complexity for object type
                  innerComplexities = addComplexities(
                    nodeComplexity,
                    complexities,
                    inlinePossibleTypeNames
                  );
                }
                break;
              }
              default: {
                // Unreachable: all selection kinds (Field, FragmentSpread,
                // InlineFragment) are handled above. The cast keeps this
                // compatible across graphql versions whose AST `kind` typings
                // differ (enum vs string literal), which affect how the switch
                // narrows the node type in this branch.
                innerComplexities = addComplexities(
                  this.nodeComplexity(
                    childNode as FieldNode,
                    typeDef,
                    activeFragments
                  ),
                  complexities,
                  possibleTypeNames
                );
                break;
              }
            }

            return innerComplexities;
          },
          {}
        );
      if (proofChildren) {
        // The total complexity is strictly reduced from the proof tree
        return reduceProofChildren(proofChildren, possibleTypeNames).complexity;
      }
      // Only return max complexity of all possible types
      if (!selectionSetComplexities) {
        return NaN;
      }
      return Math.max(...Object.values(selectionSetComplexities), 0);
    }
    return 0;
  }

  possibleTypeNames(
    typeDef: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType
  ): string[] {
    if (isAbstractType(typeDef)) {
      return this.context
        .getSchema()
        .getPossibleTypes(typeDef)
        .map((t) => t.name);
    }
    return [typeDef.name];
  }

  /**
   * Summarizes the `if` argument of a @include/@skip directive. Variable
   * references are recorded as non-sensitive summaries (coercion type +
   * normalized numeric summary), never as raw input values.
   */
  summarizeDirectiveArgument(
    directive: DirectiveNode,
    value: boolean
  ): boolean | ProofVariableSummary {
    const ifArgument = directive.arguments?.find(
      (argument) => argument.name.value === 'if'
    );
    if (ifArgument && ifArgument.value.kind === 'Variable') {
      const variableName = ifArgument.value.name.value;
      return {
        variable: variableName,
        type: this.variableTypes[variableName] ?? 'Unknown',
        summary: numericSummary(value),
      };
    }
    return value;
  }

  /**
   * Builds a proof node for a selection that was excluded by @skip/@include.
   * Excluded nodes contribute no complexity but keep the directive decisions
   * that removed them.
   */
  buildExcludedProofNode(
    childNode: FieldNode | FragmentSpreadNode | InlineFragmentNode,
    typeDef: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType,
    fields: GraphQLFieldMap<any, any>,
    path: string[],
    directives: ProofDirectiveDecision[]
  ): ProofNode {
    const proofDirectives = nonEmptyDirectives(directives);
    switch (childNode.kind) {
      case 'Field': {
        const responseName = childNode.alias
          ? childNode.alias.value
          : childNode.name.value;
        const field = resolveField(fields, childNode.name.value);
        const proofNode: FieldProofNode = {
          kind: 'Field',
          path: [...path, responseName],
          responseName,
          fieldName: childNode.name.value,
          parentType: typeDef.name,
          included: false,
          directives: proofDirectives,
          contributesTo: [],
          estimatorIndex: null,
          ownCost: 0,
          childCost: 0,
          multiplier: 1,
          complexity: 0,
          children: [],
        };
        if (field) {
          proofNode.fieldType = String(field.type);
        }
        return proofNode;
      }
      case 'FragmentSpread': {
        const fragmentName = childNode.name.value;
        const proofNode: FragmentProofNode = {
          kind: 'FragmentSpread',
          path: [...path, `...${fragmentName}`],
          fragmentName,
          included: false,
          directives: proofDirectives,
          contributesTo: [],
          complexity: 0,
          candidates: [],
          selectedType: null,
          children: [],
        };
        const fragment = this.context.getFragment(fragmentName);
        if (fragment) {
          proofNode.typeCondition = fragment.typeCondition.name.value;
        }
        return proofNode;
      }
      case 'InlineFragment': {
        const proofNode: FragmentProofNode = {
          kind: 'InlineFragment',
          path: [
            ...path,
            childNode.typeCondition
              ? `... on ${childNode.typeCondition.name.value}`
              : '...',
          ],
          included: false,
          directives: proofDirectives,
          contributesTo: [],
          complexity: 0,
          candidates: [],
          selectedType: null,
          children: [],
        };
        if (childNode.typeCondition) {
          proofNode.typeCondition = childNode.typeCondition.name.value;
        }
        return proofNode;
      }
    }
  }

  createError(): GraphQLError {
    if (typeof this.options.createError === 'function') {
      return this.options.createError(
        this.options.maximumComplexity,
        this.complexity
      );
    }
    return new GraphQLError(
      queryComplexityMessage(this.options.maximumComplexity, this.complexity)
    );
  }
}

/**
 * GraphQL v17 changed getVariableValues() to return { variableValues }
 * (an object with a `coerced` map) instead of a `{ coerced }` map directly.
 * This helper normalizes both shapes to the container the running graphql
 * version expects, without referencing any version-specific graphql types
 * (which would leak into this package's published type definitions).
 */
function getOperationVariableValues(
  schema: GraphQLSchema,
  variableDefinitions: readonly VariableDefinitionNode[],
  inputs: Record<string, any>
): {
  variableValues: Record<string, any>;
  errors?: ReadonlyArray<GraphQLError>;
} {
  const result = getVariableValues(schema, variableDefinitions, inputs) as {
    coerced?: Record<string, any>;
    variableValues?: Record<string, any>;
    errors?: ReadonlyArray<GraphQLError>;
  };

  return {
    variableValues: result.variableValues ?? result.coerced ?? {},
    errors: result.errors,
  };
}

/**
 * Forwards the version-correct variable values (already shaped by
 * getOperationVariableValues) to getArgumentValues / getDirectiveValues
 * unchanged, mapping only the empty case to `undefined`.
 */
function getExecutionVariableValues(variableValues: Record<string, any>): any {
  if (!variableValues || Object.keys(variableValues).length === 0) {
    return undefined;
  }

  return variableValues;
}

/**
 * Adds a complexity to the complexity map for all possible types
 * @param complexity
 * @param complexityMap
 * @param possibleTypes
 */
function addComplexities(
  complexity: number,
  complexityMap: ComplexityMap,
  possibleTypes: string[]
): ComplexityMap {
  for (const type of possibleTypes) {
    if (Object.prototype.hasOwnProperty.call(complexityMap, type)) {
      complexityMap[type] += complexity;
    } else {
      complexityMap[type] = complexity;
    }
  }
  return complexityMap;
}

/**
 * Resolves a field definition by name, including the introspection meta
 * fields, or returns null for unknown fields.
 */
function resolveField(
  fields: GraphQLFieldMap<any, any>,
  name: string
): GraphQLField<any, any> | null {
  switch (name) {
    case SchemaMetaFieldDef.name:
      return SchemaMetaFieldDef;
    case TypeMetaFieldDef.name:
      return TypeMetaFieldDef;
    case TypeNameMetaFieldDef.name:
      return TypeNameMetaFieldDef;
    default:
      return fields[name] ?? null;
  }
}

/**
 * Normalized numeric summary of a coerced value: numbers are kept, booleans
 * become 0/1, strings and arrays are represented by their length. Anything
 * else is recorded as null. Raw input values are never echoed.
 */
function numericSummary(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length;
  }
  return null;
}

/**
 * Records argument values as non-sensitive summaries: the declared argument
 * type used for coercion plus a normalized numeric summary.
 */
function summarizeArguments(
  argumentDefinitions: ReadonlyArray<GraphQLArgument>,
  args: Record<string, any>
): Record<string, ProofArgumentSummary> {
  const summaries: Record<string, ProofArgumentSummary> = {};
  for (const name of Object.keys(args)) {
    const definition = argumentDefinitions?.find(
      (argument) => argument.name === name
    );
    summaries[name] = {
      type: definition ? String(definition.type) : 'Unknown',
      summary: numericSummary(args[name]),
    };
  }
  return summaries;
}

function nonEmptyDirectives(
  directives: ProofDirectiveDecision[] | undefined
): ProofDirectiveDecision[] | undefined {
  return directives && directives.length ? directives : undefined;
}

/**
 * Strictly reduces the proof children of a node to per-candidate
 * complexities and the node total (the maximum over all concrete type
 * candidates). The selected type is the first candidate that reaches the
 * maximum, which is the rationale for the max selection.
 */
function reduceProofChildren(
  children: ProofNode[],
  possibleTypeNames: string[]
): {
  candidates: ProofCandidate[];
  selectedType: string | null;
  complexity: number;
} {
  const totals: ComplexityMap = {};
  for (const child of children) {
    for (const typeName of child.contributesTo) {
      if (Object.prototype.hasOwnProperty.call(totals, typeName)) {
        totals[typeName] += child.complexity;
      } else {
        totals[typeName] = child.complexity;
      }
    }
  }
  const candidateTypeNames = [...possibleTypeNames];
  for (const typeName of Object.keys(totals)) {
    if (!candidateTypeNames.includes(typeName)) {
      candidateTypeNames.push(typeName);
    }
  }
  const candidates = candidateTypeNames.map((typeName) => ({
    type: typeName,
    complexity: totals[typeName] ?? 0,
  }));
  let selectedType: string | null = null;
  let complexity = 0;
  for (const candidate of candidates) {
    if (candidate.complexity > complexity) {
      complexity = candidate.complexity;
      selectedType = candidate.type;
    }
  }
  if (selectedType === null && candidates.length) {
    // All candidates are 0, select the first one
    selectedType = candidates[0].type;
  }
  return { candidates, selectedType, complexity };
}
