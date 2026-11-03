package shane.leetcode.problems.easy;

import io.github.shanepark.leetcode.TreeNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90006SeasonedBranches {

    @Test
    public void test() {
        assertThat(seasonBranches(TreeNode.of(1, 2, 3))).isEqualTo(TreeNode.of(1, 3, 4));
        assertThat(seasonBranches(TreeNode.of(5, null, 7, null, 9))).isEqualTo(TreeNode.of(5, null, 8, null, 11));
        assertThat(seasonBranches(null)).isNull();
    }

    public TreeNode seasonBranches(TreeNode root) {
        season(root, 0);
        return root;
    }

    private void season(TreeNode node, int depth) {
        if (node == null) {
            return;
        }
        node.val += depth;
        season(node.left, depth + 1);
        season(node.right, depth + 1);
    }

}
