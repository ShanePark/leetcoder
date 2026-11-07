package shane.leetcode.problems.medium;

import io.github.shanepark.leetcode.TreeNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90007HigherRankInTheChart {

    @Test
    public void test() {
        TreeNode root = TreeNode.of(7, 3, 9, null, 4);
        assertThat(higherRanked(root, root.left.right, root.right)).isEqualTo(root.right);
        TreeNode root2 = TreeNode.of(7, 3, 9, null, 4);
        assertThat(higherRanked(root2, root2.left, root2.left.right)).isEqualTo(root2.left);
        TreeNode root3 = TreeNode.of(1, 2, 3);
        assertThat(higherRanked(root3, root3.left, root3.right)).isNull();
    }

    public TreeNode higherRanked(TreeNode root, TreeNode a, TreeNode b) {
        int depthOfA = depth(root, a, 0);
        int depthOfB = depth(root, b, 0);
        if (depthOfA == depthOfB) {
            return null;
        }
        return depthOfA < depthOfB ? a : b;
    }

    private int depth(TreeNode node, TreeNode target, int current) {
        if (node == null) {
            return -1;
        }
        if (node == target) {
            return current;
        }
        int left = depth(node.left, target, current + 1);
        return left >= 0 ? left : depth(node.right, target, current + 1);
    }

}
