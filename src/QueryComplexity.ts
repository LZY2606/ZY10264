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
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  GraphQLField,
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
  isListType,
  isNonNullType,
  isEnumType,
  typeFromAST,
} from 'graphql';

export type ComplexityEstimatorArgs = {
  type: GraphQLCompositeType;
  field: GraphQLField<any, any>;
  node: FieldNode;
  args: { [key: string]: any };
  childComplexity: number;
  context?: Record<string, any>;
};

/**
 * A single multiplier factor that was applied to a field complexity. The value
 * is always a finite number (null / undefined multipliers are ignored by the
 * estimators). When the factor was derived from a variable reference, the
 * variable name is exposed via `variable`; the full variable value is never
 * included (see ComplexityVariableSummary).
 */
export type ComplexityMultiplierFactor = {
  // Argument path of the factor (lodash.get notation, e.g. "filter.limit")
  path: string;
  // Normalized numeric value that was actually multiplied with
  value: number;
  // Name of the variable that provided the factor, if any
  variable?: string;
};

/**
 * Structured result an estimator may return instead of a plain number. All
 * values (cost, ownCost, childCost, multiplier) must reconcile with the
 * plain-number semantics: cost === (ownCost + childCost) * multiplier.
 * Plain number returns remain fully supported (legacy estimators).
 */
export type ComplexityEstimate = {
  // Total complexity this estimator assigns to the field
  cost: number;
  // Complexity of the field itself, excluding child selections
  ownCost: number;
  // Complexity contributed by child selections before multiplication
  childCost: number;
  // Product of all list multiplier factors applied to the field (default 1)
  multiplier: number;
  // Individual multiplier factors in estimator order
  multiplierFactors?: ComplexityMultiplierFactor[];
};

export type ComplexityEstimatorResult = number | ComplexityEstimate | void;

export type ComplexityEstimator = (
  options: ComplexityEstimatorArgs
) => ComplexityEstimatorResult;

// Complexity can be anything that is supported by the configured estimators
export type Complexity = any;

// Map of complexities for possible types (of Union, Interface types)
type ComplexityMap = {
  [typeName: string]: number;
};

/**
 * Sensitive-value safe summary of a variable that influenced complexity.
 * Raw variable input values are never exposed: only the coercion target type
 * and a normalized numeric summary are recorded.
 */
export type ComplexityVariableSummary = {
  // Variable name as referenced in the operation ($ prefix omitted)
  name: string;
  // GraphQL type the variable is coerced against (printed, e.g. "[Int!]")
  type?: string;
  // true when the coercion type is a list input type
  isList?: boolean;
  // For numeric scalars: the normalized numeric value (may be NaN)
  numericValue?: number;
  // For list typed variables: the array length
  arrayLength?: number;
  // true when the (coerced) value is null
  isNull?: boolean;
  // true when the value is a boolean scalar
  isBoolean?: boolean;
  // true when the value is an enum scalar
  isEnum?: boolean;
};

/**
 * How a directive affected the inclusion / scoring of a selection node.
 * `included` is false for @skip(if: true) / @include(if: false).
 */
export type ComplexityDirectiveDecision = {
  name: string;
  // Effective inclusion decision. Undefined for directives that do not
  // determine inclusion (e.g. the complexity scoring directive).
  included?: boolean;
  // Resolved directive arguments, only for non skip/include directives
  args?: { [key: string]: any };
};

/**
 * Named fragment (spread) an occurrence is contained in. Only the nearest
 * enclosing named fragment is recorded; inline fragments do not change the
 * fragment origin.
 */
export type ComplexityFragmentOrigin = {
  name: string;
  typeCondition: string;
};

/**
 * Error encountered during complexity analysis with the response path of the
 * node that triggered it.
 */
export type ComplexityProofError = {
  message: string;
  // Response path at which the error occurred (operation root not included)
  path?: ReadonlyArray<string>;
  // Fully qualified schema field name (TypeName.fieldName), if applicable
  field?: string;
};

export type ComplexityProofBase = {
  // Stable DFS pre-order index, unique per occurrence within the operation
  order: number;
  // Response path (alias names are used, meta fields keep their name)
  path: ReadonlyArray<string>;
  // Concrete possible type names this occurrence contributes its cost to
  appliesTo: ReadonlyArray<string>;
  // Nearest enclosing named fragment, if any
  fragment?: ComplexityFragmentOrigin;
  // Directive decisions encountered on the node (skip/include etc.)
  directives?: ComplexityDirectiveDecision[];
  // Variables referenced by the node (with sensitive-value safe summaries)
  variables?: ComplexityVariableSummary[];
  // Analysis errors that were reported while processing this node
  errors?: ComplexityProofError[];
};

export type ComplexityFieldProof = ComplexityProofBase & {
  kind: 'field';
  // Response key: alias if present, otherwise the field name
  responseKey: string;
  // Schema field identity (never the alias): "TypeName.fieldName"
  fieldName: string;
  // Name of the estimator that produced the score (best effort)
  estimator?: string;
  // Zero based index of the estimator within the configured estimator chain
  estimatorIndex?: number;
  // true when every estimator declined and an error was reported
  shortCircuited?: boolean;
  // true when the node was skipped via @skip/@include
  excluded?: boolean;
  // true when the field could not be resolved on the schema
  unknown?: boolean;
  // Complexity assigned by the estimator (strict reduction uses this value)
  cost?: number;
  // Field own complexity excluding multiplied child complexity
  ownCost?: number;
  // Child complexity as passed into the estimator (pre multiplication)
  childCost?: number;
  // Total multiplier applied (product of multiplierFactors)
  multiplier?: number;
  // Individual list multiplier factors in estimator order
  multiplierFactors?: ComplexityMultiplierFactor[];
  // Child selection set proof for composite fields
  children?: ComplexityProof;
};

export type ComplexityFragmentSpreadProof = ComplexityProofBase & {
  kind: 'fragmentSpread';
  fragmentName: string;
  typeCondition: string;
  // true when the spread was not expanded because of a traversal cycle
  cycle?: boolean;
  // true when the spread was excluded via @skip/@include
  excluded?: boolean;
  // true when the named fragment is not defined in the document
  unknown?: boolean;
  // Expanded selection set proof (undefined for cycle / unknown spreads)
  children?: ComplexityProof;
};

export type ComplexityInlineFragmentProof = ComplexityProofBase & {
  kind: 'inlineFragment';
  // Type condition name, undefined for an inline fragment without condition
  typeCondition?: string;
  // true when excluded via @skip/@include
  excluded?: boolean;
  children?: ComplexityProof;
};

export type ComplexityProofEntry =
  | ComplexityFieldProof
  | ComplexityFragmentSpreadProof
  | ComplexityInlineFragmentProof;

/**
 * A selection set in the proof tree. Complexity is tracked independently for
 * every concrete possible type; `total` is the maximum over the concrete
 * candidate totals, matching the numeric algorithm.
 */
export type ComplexityProof = {
  // Parent type of the selection set (object or abstract type name)
  parentType: string;
  // true when the parent type is an interface or union
  abstract: boolean;
  // Occurrences in document traversal order (DFS pre-order indices assigned
  // in the same order)
  entries: ComplexityProofEntry[];
  // Concrete type name -> summed complexity contributed to that type
  typeTotals: { [typeName: string]: number };
  // Summed totals of every concrete possible type, in schema definition order
  candidates: ReadonlyArray<{ type: string; total: number }>;
  // Concrete type with the highest total (first one on ties)
  selectedType?: string;
  // Maximum of the concrete candidate totals
  total: number;
};

/**
 * Proof for a single evaluated operation.
 */
export type OperationProof = {
  operation: string;
  root: ComplexityProof;
  total: number;
  errors: ComplexityProofError[];
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
  onComplete?: (complexity: number, proof?: OperationProof) => void;

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

  // Set to true to collect a proof tree alongside the numeric complexity.
  // The proof is built during the same traversal and is passed to onComplete.
  // When false (the default), no proof objects are allocated.
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
  onComplete?: (complexity: number, proof?: OperationProof) => void;
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
    onComplete: options.onComplete,
  });

  visit(options.query, visitWithTypeInfo(typeInfo, visitor));

  // Throw first error if any
  if (errors.length) {
    throw errors.pop();
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
  // Proof trees of the evaluated operations (only when proofTree is enabled)
  proofs: Array<OperationProof>;
  // Variable definitions of the currently active operation (proof mode only)
  private variableDefinitions: ReadonlyArray<VariableDefinitionNode>;
  // Monotonic DFS pre-order counter shared across all operations
  private proofOrder: number;
  // Errors collected for the currently active operation (proof mode only)
  private operationProofErrors: ComplexityProofError[];
  // Proof of the currently active operation (proof mode only)
  private currentOperationProof: OperationProof | undefined;

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
    this.proofs = [];
    this.variableDefinitions = [];
    this.proofOrder = 0;
    this.operationProofErrors = [];
    this.currentOperationProof = undefined;

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
    if (this.proofEnabled()) {
      this.operationProofErrors = [];
      this.currentOperationProof = undefined;
    }
    const variableDefinitions = operation.variableDefinitions
      ? // We have to create a new array here because input argument is not readonly in graphql ~14.6.0
        [...operation.variableDefinitions]
      : [];
    const { variableValues, errors } = getOperationVariableValues(
      this.context.getSchema(),
      variableDefinitions,
      this.options.variables ?? {}
    );
    if (errors && errors.length) {
      // We have input validation errors, report errors and abort
      if (this.proofEnabled()) {
        for (const error of errors) {
          this.addProofError(error, []);
        }
      }
      errors.forEach((error) => this.context.reportError(error));
      return;
    }
    this.variableValues = variableValues;
    this.variableDefinitions = variableDefinitions;

    let rootType: GraphQLObjectType | null | undefined;
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

    const rootFrame = this.proofEnabled()
      ? this.createProofFrame(rootType ?? undefined, [])
      : undefined;
    const opComplexity = this.nodeComplexity(
      operation,
      rootType ?? undefined,
      new Set(),
      [],
      undefined,
      rootFrame
    );
    this.complexity += opComplexity;

    if (this.proofEnabled() && rootFrame) {
      const proof: OperationProof = {
        operation: operation.name ? operation.name.value : '',
        root: rootFrame,
        total: opComplexity,
        errors: this.operationProofErrors,
      };
      this.proofs.push(proof);
      this.currentOperationProof = proof;
    }
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
      this.options.onComplete(
        this.complexity,
        this.proofEnabled() ? this.currentOperationProof : undefined
      );
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
    responsePath: ReadonlyArray<string> = [],
    nearestFragment: ComplexityFragmentOrigin | undefined = undefined,
    proofFrame?: ComplexityProof
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
      let possibleTypeNames: string[];
      if (isAbstractType(typeDef)) {
        possibleTypeNames = this.context
          .getSchema()
          .getPossibleTypes(typeDef)
          .map((t) => t.name);
      } else {
        possibleTypeNames = [typeDef.name];
      }

      // Numeric complexity map and, when proof collection is enabled, the
      // exact same map is exposed through the frame so the tree reduces to
      // identical totals.
      const selectionSetComplexities: ComplexityMap = {};
      if (proofFrame) {
        proofFrame.typeTotals = selectionSetComplexities;
      }

      node.selectionSet.selections.reduce(
        (
          complexities: ComplexityMap,
          childNode: FieldNode | FragmentSpreadNode | InlineFragmentNode
        ): ComplexityMap => {
          this.evaluatedNodes++;
          if (this.evaluatedNodes >= this.maxQueryNodes) {
            const error = proofFrame
              ? new GraphQLError(
                  'Query exceeds the maximum allowed number of nodes.',
                  {
                    path: responsePath,
                  } as any
                )
              : new GraphQLError(
                  'Query exceeds the maximum allowed number of nodes.'
                );
            if (proofFrame) {
              this.addProofError(error, responsePath);
            }
            throw error;
          }
          let innerComplexities = complexities;

          let includeNode = true;
          let skipNode = false;
          // Only allocated when proof collection is enabled
          let directiveDecisions: ComplexityDirectiveDecision[] | undefined;
          // DFS pre-order index of this occurrence, assigned when the node is
          // entered (before child selections are traversed)
          const entryOrder = proofFrame ? this.nextProofOrder() : 0;

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
                }
                if (proofFrame) {
                  (directiveDecisions ??= []).push({
                    name: directiveName,
                    included: includeNode,
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
                }
                if (proofFrame) {
                  (directiveDecisions ??= []).push({
                    name: directiveName,
                    included: !skipNode,
                  });
                }
                break;
              }
              default: {
                if (proofFrame) {
                  // Only the directive name is recorded. Raw argument values
                  // are intentionally not echoed (sensitive inputs).
                  (directiveDecisions ??= []).push({ name: directiveName });
                }
                break;
              }
            }
          }

          if (!includeNode || skipNode) {
            if (proofFrame) {
              proofFrame.entries.push(
                this.createExcludedEntry(
                  childNode,
                  responsePath,
                  nearestFragment,
                  directiveDecisions,
                  fields,
                  typeDef,
                  entryOrder
                )
              );
            }
            return complexities;
          }

          switch (childNode.kind) {
            case 'Field': {
              let field = null;

              switch (childNode.name.value) {
                case SchemaMetaFieldDef.name:
                  field = SchemaMetaFieldDef;
                  break;
                case TypeMetaFieldDef.name:
                  field = TypeMetaFieldDef;
                  break;
                case TypeNameMetaFieldDef.name:
                  field = TypeNameMetaFieldDef;
                  break;
                default:
                  field = fields[childNode.name.value];
                  break;
              }

              const responseKey = childNode.alias
                ? childNode.alias.value
                : childNode.name.value;
              const fieldPath = proofFrame
                ? [...responsePath, responseKey]
                : responsePath;

              // Invalid field, should be caught by other validation rules
              if (!field) {
                if (proofFrame) {
                  proofFrame.entries.push({
                    kind: 'field',
                    order: entryOrder,
                    path: fieldPath,
                    responseKey,
                    fieldName: `${typeDef.name}.${childNode.name.value}`,
                    appliesTo: [],
                    fragment: nearestFragment,
                    directives: this.withDirectives(directiveDecisions),
                    unknown: true,
                  });
                }
                break;
              }
              const fieldType = getNamedType(field.type);

              // Get arguments
              let args: { [key: string]: any };
              try {
                args = getArgumentValues(
                  field,
                  childNode,
                  getExecutionVariableValues(this.variableValues)
                );
              } catch (e) {
                this.context.reportError(e);
                if (proofFrame) {
                  const entry: ComplexityFieldProof = {
                    kind: 'field',
                    order: entryOrder,
                    path: fieldPath,
                    responseKey,
                    fieldName: `${typeDef.name}.${field.name}`,
                    appliesTo: [],
                    fragment: nearestFragment,
                    directives: this.withDirectives(directiveDecisions),
                    variables: this.collectVariableUsages(childNode),
                    errors: [this.toProofError(e, fieldPath, typeDef, field)],
                  };
                  proofFrame.entries.push(entry);
                }
                return complexities;
              }

              // Check if we have child complexity
              let childComplexity = 0;
              let childFrame: ComplexityProof | undefined;
              if (isCompositeType(fieldType)) {
                childFrame = proofFrame
                  ? this.createProofFrame(fieldType, fieldPath)
                  : undefined;
                childComplexity = this.nodeComplexity(
                  childNode,
                  fieldType,
                  activeFragments,
                  fieldPath,
                  nearestFragment,
                  childFrame
                );
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
              let matchedScore: number | undefined;
              let matchedEstimate: ComplexityEstimate | undefined;
              let matchedIndex = -1;
              this.estimators.find((estimator, estimatorIndex) => {
                const tmpResult = estimator(estimatorArgs);
                const estimate = normalizeEstimatorResult(
                  tmpResult,
                  childComplexity
                );

                if (estimate !== undefined) {
                  matchedScore = estimate.cost;
                  matchedEstimate = estimate;
                  matchedIndex = estimatorIndex;
                  innerComplexities = addComplexities(
                    estimate.cost,
                    complexities,
                    possibleTypeNames
                  );
                  return true;
                }

                return false;
              });
              if (matchedScore === undefined) {
                this.context.reportError(
                  new GraphQLError(
                    `No complexity could be calculated for field ${typeDef.name}.${field.name}. ` +
                      'At least one complexity estimator has to return a complexity score.'
                  )
                );
                if (proofFrame) {
                  const message =
                    `No complexity could be calculated for field ${typeDef.name}.${field.name}. ` +
                    'At least one complexity estimator has to return a complexity score.';
                  proofFrame.entries.push({
                    kind: 'field',
                    order: entryOrder,
                    path: fieldPath,
                    responseKey,
                    fieldName: `${typeDef.name}.${field.name}`,
                    appliesTo: [],
                    fragment: nearestFragment,
                    directives: this.withDirectives(directiveDecisions),
                    variables: this.collectVariableUsages(childNode),
                    shortCircuited: true,
                    cost: 0,
                    ownCost: 0,
                    childCost: childComplexity,
                    multiplier: 1,
                    children: childFrame,
                    errors: [{ message, path: fieldPath }],
                  });
                }
                return complexities;
              }
              if (proofFrame) {
                proofFrame.entries.push({
                  kind: 'field',
                  order: entryOrder,
                  path: fieldPath,
                  responseKey,
                  fieldName: `${typeDef.name}.${field.name}`,
                  appliesTo: possibleTypeNames,
                  fragment: nearestFragment,
                  directives: this.withDirectives(directiveDecisions),
                  variables: this.collectVariableUsages(childNode),
                  estimator: estimatorName(this.estimators[matchedIndex]),
                  estimatorIndex: matchedIndex,
                  cost: matchedScore,
                  ownCost: matchedEstimate!.ownCost,
                  childCost: matchedEstimate!.childCost,
                  multiplier: matchedEstimate!.multiplier,
                  multiplierFactors: matchedEstimate!.multiplierFactors,
                  children: childFrame,
                });
              }
              break;
            }
            case 'FragmentSpread': {
              const fragmentName = childNode.name.value;
              const fragment = this.context.getFragment(fragmentName);
              // Unknown fragment, should be caught by other validation rules
              if (!fragment) {
                if (proofFrame) {
                  proofFrame.entries.push({
                    kind: 'fragmentSpread',
                    order: entryOrder,
                    path: responsePath,
                    fragmentName,
                    typeCondition: '',
                    appliesTo: [],
                    fragment: nearestFragment,
                    directives: this.withDirectives(directiveDecisions),
                    unknown: true,
                  });
                }
                break;
              }
              // Circular fragment reference — skip to avoid infinite recursion
              if (activeFragments.has(fragmentName)) {
                if (proofFrame) {
                  proofFrame.entries.push({
                    kind: 'fragmentSpread',
                    order: entryOrder,
                    path: responsePath,
                    fragmentName,
                    typeCondition: fragment.typeCondition.name.value,
                    appliesTo: [],
                    fragment: nearestFragment,
                    directives: this.withDirectives(directiveDecisions),
                    cycle: true,
                  });
                }
                break;
              }
              const fragmentType = this.context
                .getSchema()
                .getType(fragment.typeCondition.name.value);
              // Invalid fragment type, ignore. Should be caught by other validation rules
              if (!isCompositeType(fragmentType)) {
                if (proofFrame) {
                  proofFrame.entries.push({
                    kind: 'fragmentSpread',
                    order: entryOrder,
                    path: responsePath,
                    fragmentName,
                    typeCondition: fragment.typeCondition.name.value,
                    appliesTo: [],
                    fragment: nearestFragment,
                    directives: this.withDirectives(directiveDecisions),
                    unknown: true,
                  });
                }
                break;
              }
              // Track this fragment on the active path so deeper spreads can
              // detect cycles, then remove it on the way back up (backtracking)
              // to avoid copying the set on every descent.
              activeFragments.add(fragmentName);
              const fragmentOrigin: ComplexityFragmentOrigin = {
                name: fragmentName,
                typeCondition: fragment.typeCondition.name.value,
              };
              const spreadFrame = proofFrame
                ? this.createProofFrame(fragmentType, responsePath)
                : undefined;
              const nodeComplexity = this.nodeComplexity(
                fragment,
                fragmentType,
                activeFragments,
                responsePath,
                fragmentOrigin,
                spreadFrame
              );
              activeFragments.delete(fragmentName);
              if (proofFrame && spreadFrame) {
                proofFrame.entries.push({
                  kind: 'fragmentSpread',
                  order: entryOrder,
                  path: responsePath,
                  fragmentName,
                  typeCondition: fragment.typeCondition.name.value,
                  appliesTo: isAbstractType(fragmentType)
                    ? this.context
                        .getSchema()
                        .getPossibleTypes(fragmentType)
                        .map((t) => t.name)
                    : [fragmentType.name],
                  fragment: nearestFragment,
                  directives: this.withDirectives(directiveDecisions),
                  children: spreadFrame,
                });
              }
              if (isAbstractType(fragmentType)) {
                // Add fragment complexity for all possible types
                innerComplexities = addComplexities(
                  nodeComplexity,
                  complexities,
                  this.context
                    .getSchema()
                    .getPossibleTypes(fragmentType)
                    .map((t) => t.name)
                );
              } else {
                // Add complexity for object type
                innerComplexities = addComplexities(
                  nodeComplexity,
                  complexities,
                  [fragmentType.name]
                );
              }
              break;
            }
            case 'InlineFragment': {
              let inlineFragmentType: GraphQLNamedType = typeDef;
              if (childNode.typeCondition && childNode.typeCondition.name) {
                inlineFragmentType = this.context
                  .getSchema()
                  .getType(childNode.typeCondition.name.value);
                if (!isCompositeType(inlineFragmentType)) {
                  if (proofFrame) {
                    proofFrame.entries.push({
                      kind: 'inlineFragment',
                      order: entryOrder,
                      path: responsePath,
                      typeCondition: childNode.typeCondition.name.value,
                      appliesTo: [],
                      fragment: nearestFragment,
                      directives: this.withDirectives(directiveDecisions),
                      children: this.createProofFrame(undefined, responsePath),
                    });
                  }
                  break;
                }
              }

              const inlineFrame = proofFrame
                ? this.createProofFrame(inlineFragmentType, responsePath)
                : undefined;
              const nodeComplexity = this.nodeComplexity(
                childNode,
                inlineFragmentType,
                activeFragments,
                responsePath,
                nearestFragment,
                inlineFrame
              );
              if (proofFrame && inlineFrame) {
                proofFrame.entries.push({
                  kind: 'inlineFragment',
                  order: entryOrder,
                  path: responsePath,
                  typeCondition: childNode.typeCondition
                    ? childNode.typeCondition.name.value
                    : undefined,
                  appliesTo: isAbstractType(inlineFragmentType)
                    ? this.context
                        .getSchema()
                        .getPossibleTypes(inlineFragmentType)
                        .map((t) => t.name)
                    : [inlineFragmentType.name],
                  fragment: nearestFragment,
                  directives: this.withDirectives(directiveDecisions),
                  children: inlineFrame,
                });
              }
              if (isAbstractType(inlineFragmentType)) {
                // Add fragment complexity for all possible types
                innerComplexities = addComplexities(
                  nodeComplexity,
                  complexities,
                  this.context
                    .getSchema()
                    .getPossibleTypes(inlineFragmentType)
                    .map((t) => t.name)
                );
              } else {
                // Add complexity for object type
                innerComplexities = addComplexities(
                  nodeComplexity,
                  complexities,
                  [inlineFragmentType.name]
                );
              }
              break;
            }
            default: {
              // Unreachable: all selection kinds (Field, FragmentSpread,
              // InlineFragment) are handled above. The cast keeps this
              // compatible across graphql versions whose AST `kind` typings
              // differ (enum vs string literal), which affect how the switch
              // narrows the node type in this branch. Proof entries are not
              // recorded for this legacy fallback path.
              innerComplexities = addComplexities(
                this.nodeComplexity(
                  childNode as FieldNode,
                  typeDef,
                  activeFragments,
                  responsePath,
                  nearestFragment,
                  undefined
                ),
                complexities,
                possibleTypeNames
              );
              break;
            }
          }

          return innerComplexities;
        },
        selectionSetComplexities
      );
      // Only return max complexity of all possible types
      if (!selectionSetComplexities) {
        return NaN;
      }
      const total = Math.max(...Object.values(selectionSetComplexities), 0);
      if (proofFrame) {
        this.finalizeProofFrame(proofFrame, typeDef, possibleTypeNames, total);
      }
      return total;
    }
    return 0;
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

  private proofEnabled(): boolean {
    return this.options.proofTree === true;
  }

  private nextProofOrder(): number {
    return this.proofOrder++;
  }

  private createProofFrame(
    typeDef: GraphQLCompositeType | GraphQLNamedType | undefined,
    path: ReadonlyArray<string>
  ): ComplexityProof {
    return {
      parentType: typeDef ? typeDef.name : '',
      abstract: typeDef ? isAbstractType(typeDef) : false,
      entries: [],
      typeTotals: {},
      candidates: [],
      total: 0,
    };
  }

  private finalizeProofFrame(
    frame: ComplexityProof,
    typeDef: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType,
    possibleTypeNames: string[],
    total: number
  ): void {
    frame.parentType = typeDef.name;
    frame.abstract = isAbstractType(typeDef);
    frame.candidates = possibleTypeNames.map((typeName) => ({
      type: typeName,
      total: Object.prototype.hasOwnProperty.call(frame.typeTotals, typeName)
        ? frame.typeTotals[typeName]
        : 0,
    }));
    let selectedType: string | undefined;
    let selectedTotal = -Infinity;
    for (const candidate of frame.candidates) {
      if (candidate.total > selectedTotal) {
        selectedTotal = candidate.total;
        selectedType = candidate.type;
      }
    }
    frame.selectedType = selectedType;
    frame.total = total;
  }

  private addProofError(
    error: GraphQLError | Error | any,
    path: ReadonlyArray<string>
  ): void {
    this.operationProofErrors.push({
      message: error && error.message ? error.message : String(error),
      path: path.length ? path : undefined,
    });
  }

  private toProofError(
    error: any,
    path: ReadonlyArray<string>,
    typeDef: GraphQLCompositeType,
    field: GraphQLField<any, any>
  ): ComplexityProofError {
    return {
      message: error && error.message ? error.message : String(error),
      path,
      field: `${typeDef.name}.${field.name}`,
    };
  }

  private withDirectives(
    decisions: ComplexityDirectiveDecision[] | undefined
  ): ComplexityDirectiveDecision[] | undefined {
    return decisions && decisions.length ? decisions : undefined;
  }

  private createExcludedEntry(
    childNode: FieldNode | FragmentSpreadNode | InlineFragmentNode,
    responsePath: ReadonlyArray<string>,
    nearestFragment: ComplexityFragmentOrigin | undefined,
    directiveDecisions: ComplexityDirectiveDecision[] | undefined,
    fields: GraphQLFieldMap<any, any>,
    typeDef: GraphQLCompositeType,
    entryOrder: number
  ): ComplexityProofEntry {
    const directives = this.withDirectives(directiveDecisions);
    switch (childNode.kind) {
      case 'Field': {
        const responseKey = childNode.alias
          ? childNode.alias.value
          : childNode.name.value;
        let fieldName = childNode.name.value;
        switch (childNode.name.value) {
          case SchemaMetaFieldDef.name:
          case TypeMetaFieldDef.name:
          case TypeNameMetaFieldDef.name:
            break;
          default:
            if (fields[childNode.name.value]) {
              fieldName = fields[childNode.name.value].name;
            }
            break;
        }
        return {
          kind: 'field',
          order: entryOrder,
          path: [...responsePath, responseKey],
          responseKey,
          fieldName: `${typeDef.name}.${fieldName}`,
          fragment: nearestFragment,
          directives,
          excluded: true,
          appliesTo: [],
        };
      }
      case 'FragmentSpread': {
        const fragmentName = childNode.name.value;
        const fragment = this.context.getFragment(fragmentName);
        return {
          kind: 'fragmentSpread',
          order: entryOrder,
          path: responsePath,
          fragmentName,
          typeCondition: fragment ? fragment.typeCondition.name.value : '',
          fragment: nearestFragment,
          directives,
          excluded: true,
          appliesTo: [],
        };
      }
      default: {
        return {
          kind: 'inlineFragment',
          order: entryOrder,
          path: responsePath,
          typeCondition: childNode.typeCondition
            ? childNode.typeCondition.name.value
            : undefined,
          fragment: nearestFragment,
          directives,
          excluded: true,
          appliesTo: [],
        };
      }
    }
  }

  /**
   * Collects sensitive-value safe summaries of the variables referenced by the
   * field arguments. Only the coercion target type and normalized numeric
   * summaries are exposed, raw input values are never echoed.
   */
  private collectVariableUsages(
    childNode: FieldNode
  ): ComplexityVariableSummary[] | undefined {
    if (!childNode.arguments || !childNode.arguments.length) {
      return undefined;
    }
    const variableNames: string[] = [];
    const collectFromValue = (value: any): void => {
      if (!value || typeof value !== 'object') {
        return;
      }
      switch (value.kind) {
        case 'Variable':
          if (!variableNames.includes(value.name.value)) {
            variableNames.push(value.name.value);
          }
          break;
        case 'ListValue':
          value.values.forEach(collectFromValue);
          break;
        case 'ObjectValue':
          value.fields.forEach((field: any) => collectFromValue(field.value));
          break;
        default:
          break;
      }
    };
    for (const argument of childNode.arguments) {
      collectFromValue(argument.value);
    }
    if (!variableNames.length) {
      return undefined;
    }
    const schema = this.context.getSchema();
    return variableNames.map((name) => {
      const summary: ComplexityVariableSummary = { name };
      const definition = this.variableDefinitions.find(
        (def) => def.variable.name.value === name
      );
      if (definition) {
        summary.type = print(definition.type);
        const inputType = typeFromAST(schema, definition.type);
        if (inputType) {
          let nullableType = inputType;
          if (isNonNullType(nullableType)) {
            nullableType = nullableType.ofType;
          }
          if (isListType(nullableType)) {
            summary.isList = true;
          }
          const namedType = getNamedType(inputType);
          if (isEnumType(namedType)) {
            summary.isEnum = true;
          }
        }
      }
      const value = getCoercedVariableValues(this.variableValues)[name];
      if (value === null || value === undefined) {
        summary.isNull = true;
      } else if (typeof value === 'number') {
        if (!summary.isEnum) {
          summary.numericValue = value;
        }
      } else if (typeof value === 'boolean') {
        summary.isBoolean = true;
      } else if (Array.isArray(value)) {
        summary.arrayLength = value.length;
      }
      // Strings, objects and enum values are intentionally not echoed
      return summary;
    });
  }
}

/**
 * Normalizes the return value of an estimator to a structured estimate.
 * Plain numbers remain supported (legacy API): ownCost is derived as
 * cost - childComplexity with multiplier 1.
 */
function normalizeEstimatorResult(
  result: ComplexityEstimatorResult,
  childComplexity: number
): ComplexityEstimate | undefined {
  if (typeof result === 'number') {
    if (isNaN(result)) {
      return undefined;
    }
    return {
      cost: result,
      ownCost: result - childComplexity,
      childCost: childComplexity,
      multiplier: 1,
    };
  }
  if (
    result &&
    typeof result === 'object' &&
    typeof result.cost === 'number' &&
    !isNaN(result.cost)
  ) {
    const estimate = result as ComplexityEstimate;
    return {
      cost: estimate.cost,
      ownCost:
        typeof estimate.ownCost === 'number'
          ? estimate.ownCost
          : estimate.cost - childComplexity,
      childCost:
        typeof estimate.childCost === 'number'
          ? estimate.childCost
          : childComplexity,
      multiplier:
        typeof estimate.multiplier === 'number' ? estimate.multiplier : 1,
      multiplierFactors: estimate.multiplierFactors,
    };
  }
  return undefined;
}

function estimatorName(estimator: ComplexityEstimator): string | undefined {
  return estimator.name || undefined;
}

/**
 * Strictly reduces a proof tree to its total complexity. The result must
 * equal the numeric complexity calculated during traversal.
 */
export function reduceProofTree(proof: ComplexityProof): number {
  const totals: ComplexityMap = {};
  const addTo = (typeNames: ReadonlyArray<string>, complexity: number) => {
    for (const typeName of typeNames) {
      if (Object.prototype.hasOwnProperty.call(totals, typeName)) {
        totals[typeName] += complexity;
      } else {
        totals[typeName] = complexity;
      }
    }
  };

  for (const entry of proof.entries) {
    if (entry.excluded) {
      continue;
    }
    if (entry.kind === 'field') {
      if (entry.unknown || entry.shortCircuited) {
        continue;
      }
      if (entry.errors && entry.errors.length) {
        continue;
      }
      const childTotal = entry.children ? reduceProofTree(entry.children) : 0;
      const multiplier =
        typeof entry.multiplier === 'number' ? entry.multiplier : 1;
      const ownCost = typeof entry.ownCost === 'number' ? entry.ownCost : 0;
      addTo(entry.appliesTo ?? [], (ownCost + childTotal) * multiplier);
    } else if (entry.kind === 'fragmentSpread') {
      if (entry.cycle || entry.unknown || !entry.children) {
        continue;
      }
      addTo(entry.appliesTo ?? [], reduceProofTree(entry.children));
    } else {
      if (!entry.children) {
        continue;
      }
      addTo(entry.appliesTo ?? [], reduceProofTree(entry.children));
    }
  }

  return Math.max(...Object.values(totals), 0);
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
 * Returns the map of coerced variable values from the version-dependent
 * container shaped by getOperationVariableValues. GraphQL v17 nests the
 * coerced values under a `coerced` key (alongside `sources`), older versions
 * expose the coerced map directly.
 */
function getCoercedVariableValues(
  variableValues: Record<string, any>
): Record<string, any> {
  if (
    variableValues &&
    typeof variableValues === 'object' &&
    'coerced' in variableValues &&
    'sources' in variableValues &&
    variableValues.coerced &&
    typeof variableValues.coerced === 'object'
  ) {
    return variableValues.coerced;
  }
  return variableValues ?? {};
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
