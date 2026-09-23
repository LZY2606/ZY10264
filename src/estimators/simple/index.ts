import {
  ComplexityEstimator,
  ComplexityEstimatorArgs,
  ComplexityEstimatorResult,
} from '../../QueryComplexity.js';

export default function (options?: {
  defaultComplexity?: number;
}): ComplexityEstimator {
  const defaultComplexity =
    options && typeof options.defaultComplexity === 'number'
      ? options.defaultComplexity
      : 1;
  return function simpleEstimator(
    args: ComplexityEstimatorArgs
  ): ComplexityEstimatorResult {
    return {
      cost: defaultComplexity + args.childComplexity,
      ownCost: defaultComplexity,
      childCost: args.childComplexity,
      multiplier: 1,
    };
  };
}
