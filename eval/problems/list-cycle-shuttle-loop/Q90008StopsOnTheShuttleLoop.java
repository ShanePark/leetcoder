package shane.leetcode.problems.easy;

import io.github.shanepark.leetcode.ListNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90008StopsOnTheShuttleLoop {

    @Test
    public void test() {
        ListNode head = ListNode.of(4, 8, 15, 16, 23);
        head.next.next.next.next.next = head.next.next;
        assertThat(loopStops(head)).isEqualTo(3);
        ListNode head2 = ListNode.of(1, 2);
        head2.next.next = head2;
        assertThat(loopStops(head2)).isEqualTo(2);
        assertThat(loopStops(ListNode.of(9))).isEqualTo(0);
    }

    public int loopStops(ListNode head) {
        ListNode slow = head;
        ListNode fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;
            fast = fast.next.next;
            if (slow == fast) {
                int stops = 1;
                for (ListNode stop = slow.next; stop != slow; stop = stop.next) {
                    stops++;
                }
                return stops;
            }
        }
        return 0;
    }

}
