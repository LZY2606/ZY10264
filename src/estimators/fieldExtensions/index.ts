import {
  ComplexityEstimator,
  ComplexityEstimatorArgs,
  ComplexityEstimatorResult,
} from '../../QueryComplexity.js';

export default function (): ComplexityEstimator {
  return function fieldExtensionsEstimator(
    args: ComplexityEstimatorArgs
  ): ComplexityEstimatorResult {
    if (args.field.extensions) {
      // Calculate complexity score
      if (typeof args.field.extensions.complexity === 'number') {
        return {
          cost: args.childComplexity + args.field.extensions.complexity,
          ownCost: args.field.extensions.complexity,
          childCost: args.childComplexity,
          multiplier: 1,
        };
      } else if (typeof args.field.extensions.complexity === 'function') {
        const complexity = args.field.extensions.complexity(args);
        if (typeof complexity === 'number' && !isNaN(complexity)) {
          // Custom estimator functions return an opaque total. ownCost is
          // derived so that ownCost + childCost reconciles with the total.
          return {
            cost: complexity,
            ownCost: complexity - args.childComplexity,
            childCost: args.childComplexity,
            multiplier: 1,
          };
        }
        return complexity;
      }
    }
  };
}
