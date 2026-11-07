package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90022CopyTheRelayTeam {

    @Test
    public void test() {
        Node first = new Node(6);
        Node second = new Node(11);
        Node third = new Node(8);
        first.next = second;
        second.next = third;
        first.backup = third;
        third.backup = first;
        Node copy = copyTeam(first);
        assertThat(copy).isNotSameAs(first);
        assertThat(copy.next).isNotSameAs(second);
        assertThat(copy.next.next).isNotSameAs(third);
        assertThat(copy.val).isEqualTo(6);
        assertThat(copy.next.val).isEqualTo(11);
        assertThat(copy.next.next.val).isEqualTo(8);
        assertThat(copy.next.next.next).isNull();
        assertThat(copy.backup).isSameAs(copy.next.next);
        assertThat(copy.next.backup).isNull();
        assertThat(copy.next.next.backup).isSameAs(copy);

        Node runnerA = new Node(15);
        Node runnerB = new Node(21);
        runnerA.next = runnerB;
        runnerA.backup = runnerB;
        runnerB.backup = runnerB;
        Node copy2 = copyTeam(runnerA);
        assertThat(copy2).isNotSameAs(runnerA);
        assertThat(copy2.next).isNotSameAs(runnerB);
        assertThat(copy2.val).isEqualTo(15);
        assertThat(copy2.next.val).isEqualTo(21);
        assertThat(copy2.next.next).isNull();
        assertThat(copy2.backup).isSameAs(copy2.next);
        assertThat(copy2.next.backup).isSameAs(copy2.next);

        assertThat(copyTeam(null)).isNull();
    }

    public Node copyTeam(Node leader) {
        Map<Node, Node> copies = new HashMap<>();
        for (Node node = leader; node != null; node = node.next) {
            copies.put(node, new Node(node.val));
        }
        for (Node node = leader; node != null; node = node.next) {
            copies.get(node).next = copies.get(node.next);
            copies.get(node).backup = copies.get(node.backup);
        }
        return copies.get(leader);
    }

    class Node {
        int val;
        Node next;
        Node backup;

        public Node(int val) {
            this.val = val;
            this.next = null;
            this.backup = null;
        }
    }

}
