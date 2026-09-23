import {
  ComplexityEstimator,
  ComplexityEstimatorArgs,
  ComplexityEstimatorResult,
  ComplexityMultiplierFactor,
} from '../../QueryComplexity.js';
import {
  getDirectiveValues,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
  GraphQLDirective,
  DirectiveLocation,
} from 'graphql';
import get from 'lodash.get';

/**
 * Finds the first variable name referenced by the argument value AST for the
 * given argument name (including variables nested inside lists and objects).
 */
function findArgumentVariable(
  node: ComplexityEstimatorArgs['node'],
  argumentName: string
): string | undefined {
  if (!node.arguments) {
    return undefined;
  }
  for (const argument of node.arguments) {
    if (argument.name.value !== argumentName) {
      continue;
    }
    let result: string | undefined;
    const visit = (value: any): void => {
      if (result || !value || typeof value !== 'object') {
        return;
      }
      if (value.kind === 'Variable') {
        result = value.name.value;
        return;
      }
      if (value.kind === 'ListValue') {
        value.values.forEach(visit);
      } else if (value.kind === 'ObjectValue') {
        value.fields.forEach((field: any) => visit(field.value));
      }
    };
    visit(argument.value);
    return result;
  }
  return undefined;
}

export type ComplexityDirectiveOptions = {
  name?: string;
};

export function createComplexityDirective(
  options?: ComplexityDirectiveOptions
): GraphQLDirective {
  const mergedOptions = {
    name: 'complexity',
    ...(options || {}),
  };

  return new GraphQLDirective({
    name: mergedOptions.name,
    description: 'Define a relation between the field and other nodes',
    locations: [DirectiveLocation.FIELD_DEFINITION],
    args: {
      value: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'The complexity value for the field',
      },
      multipliers: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
      },
    },
  });
}

export default function (
  options: ComplexityDirectiveOptions = {}
): ComplexityEstimator {
  const directive = createComplexityDirective(options);

  return function directiveEstimator(
    args: ComplexityEstimatorArgs
  ): ComplexityEstimatorResult {
    // Ignore if astNode is undefined
    if (!args.field.astNode) {
      return;
    }

    const values = getDirectiveValues(directive, args.field.astNode);

    // Ignore if no directive set
    if (!values) {
      return;
    }

    // Get multipliers
    let totalMultiplier = 1;
    const multiplierFactors: ComplexityMultiplierFactor[] = [];
    if (values.multipliers && Array.isArray(values.multipliers)) {
      totalMultiplier = values.multipliers.reduce(
        (aggregated: number, multiplier: string) => {
          const multiplierValue = get(args.args, multiplier);

          if (typeof multiplierValue === 'number') {
            multiplierFactors.push({
              path: multiplier,
              value: multiplierValue,
              variable: findArgumentVariable(
                args.node,
                multiplier.split('.')[0]
              ),
            });
            return aggregated * multiplierValue;
          }
          if (Array.isArray(multiplierValue)) {
            multiplierFactors.push({
              path: multiplier,
              value: multiplierValue.length,
              variable: findArgumentVariable(
                args.node,
                multiplier.split('.')[0]
              ),
            });
            return aggregated * multiplierValue.length;
          }
          return aggregated;
        },
        totalMultiplier
      );
    }

    return {
      cost: (Number(values.value) + args.childComplexity) * totalMultiplier,
      ownCost: Number(values.value),
      childCost: args.childComplexity,
      multiplier: totalMultiplier,
      multiplierFactors,
    };
  };
}
