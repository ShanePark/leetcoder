package shane.leetcode.problems.medium;

import io.github.shanepark.leetcode.TreeNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90026TwinInTheArchive {

    @Test
    public void test() {
        TreeNode master = TreeNode.of(10, 4, 12, null, 7);
        TreeNode mirror = TreeNode.of(10, 4, 12, null, 7);
        assertThat(findTwin(master, mirror, master.left.right)).isSameAs(mirror.left.right);

        TreeNode master2 = TreeNode.of(6, null, 14, 11);
        TreeNode mirror2 = TreeNode.of(6, null, 14, 11);
        assertThat(findTwin(master2, mirror2, master2.right.left)).isSameAs(mirror2.right.left);

        TreeNode master3 = TreeNode.of(20);
        TreeNode mirror3 = TreeNode.of(20);
        assertThat(findTwin(master3, mirror3, master3)).isSameAs(mirror3);
    }

    public TreeNode findTwin(TreeNode master, TreeNode mirror, TreeNode marked) {
        if (master == null) {
            return null;
        }
        if (master == marked) {
            return mirror;
        }
        TreeNode onLeft = findTwin(master.left, mirror.left, marked);
        return onLeft != null ? onLeft : findTwin(master.right, mirror.right, marked);
    }

}
