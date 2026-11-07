// The step-list view of a workflow definition (PLAN 11.10d). A recipe IS a 7.1 workflow: these modules only derive a
// friendly ordering and per-port targets from the same graph, and write edits back into that graph. Nothing here
// validates the graph: the server's validation is the authority, and the editor shows its answer beside the
// prototype's own client-side problems.

export { analyzeRecipe, recipeClientProblems, targetStepLabel } from './recipe-analysis.ts'
export {
  addRecipeStep,
  removeRecipeStep,
  setFailureMode,
  setPortTarget,
  setRejectMode,
} from './recipe-edits.ts'
export { moveRecipeStepProblem, planRecipeMove } from './recipe-move.ts'
export {
  RECIPE_STEP_LABEL,
  RECIPE_STEP_MARK,
  type RecipeAnalysis,
  type RecipeProblem,
  type RecipeRow,
} from './recipe-model-types.ts'
