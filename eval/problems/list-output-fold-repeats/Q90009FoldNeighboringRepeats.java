package shane.leetcode.problems.easy;

import io.github.shanepark.leetcode.ListNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90009FoldNeighboringRepeats {

    @Test
    public void test() {
        assertThat(foldRepeats(ListNode.of(2, 2, 5, 1, 1, 1))).isEqualTo(ListNode.of(4, 5, 3));
        assertThat(foldRepeats(ListNode.of(3, 4, 3))).isEqualTo(ListNode.of(3, 4, 3));
        assertThat(foldRepeats(null)).isNull();
    }

    public ListNode foldRepeats(ListNode head) {
        ListNode dummy = new ListNode(0);
        ListNode tail = dummy;
        ListNode node = head;
        while (node != null) {
            int value = node.val;
            int sum = 0;
            while (node != null && node.val == value) {
                sum += node.val;
                node = node.next;
            }
            tail.next = new ListNode(sum);
            tail = tail.next;
        }
        return dummy.next;
    }

}
