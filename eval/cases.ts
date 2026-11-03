const PROBLEMS = 'src/main/java/shane/leetcode/problems'

export interface EvalCase {
  number: string
  category: string
  /** The owner's solved file in the ps repository, relative to its root. */
  psFile: string
  /** The model should return no statements, because no call can be written. */
  expectEmpty?: boolean
}

// Problem text stays out of this public repository: see `eval/.cache/`.
export const EVAL_CASES: readonly EvalCase[] = [
  { number: '4', category: 'double result, literal arrays', psFile: `${PROBLEMS}/xhard/Q4MedianOfTwoSortedArrays.java` },
  { number: '57', category: '2D array in and out', psFile: `${PROBLEMS}/medium/Q57InsertInterval.java` },
  { number: '743', category: 'graph edge list', psFile: `${PROBLEMS}/medium/Q743NetworkDelayTime.java` },
  { number: '78', category: 'nested list, any order', psFile: `${PROBLEMS}/medium/Q78Subsets.java` },
  { number: '200', category: 'char grid', psFile: `${PROBLEMS}/medium/Q200NumberOfIslands2.java` },
  { number: '226', category: 'tree in and out', psFile: `${PROBLEMS}/easy/Q226InvertBinaryTree.java` },
  { number: '236', category: 'tree node references', psFile: `${PROBLEMS}/medium/Q236LowestCommonAncestorOfABinaryTree.java` },
  { number: '141', category: 'linked list cycle pos', psFile: `${PROBLEMS}/easy/Q141LinkedListCycle2.java` },
  { number: '206', category: 'linked list output', psFile: `${PROBLEMS}/easy/Q206ReverseLinkedList.java` },
  { number: '133', category: 'custom Node graph', psFile: `${PROBLEMS}/medium/Q133CloneGraph.java` },
  { number: '75', category: 'in-place void', psFile: `${PROBLEMS}/medium/Q75SortColors.java` },
  { number: '146', category: 'design class', psFile: `${PROBLEMS}/medium/Q146LRUCache.java` },
  { number: '374', category: 'platform-provided API', psFile: `${PROBLEMS}/easy/Q374GuessNumberHigherOrLower.java`, expectEmpty: true },
]
