package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90010BusiestHubInTheNetwork {

    @Test
    public void test() {
        Node node1 = new Node(1);
        Node node2 = new Node(2);
        Node node3 = new Node(3);
        Node node4 = new Node(4);
        node1.links.add(node2);
        node1.links.add(node3);
        node1.links.add(node4);
        node2.links.add(node1);
        node3.links.add(node1);
        node4.links.add(node1);
        assertThat(busiestHub(node1).val).isEqualTo(1);

        Node a1 = new Node(1);
        Node a2 = new Node(2);
        Node a3 = new Node(3);
        Node a4 = new Node(4);
        Node a5 = new Node(5);
        a1.links.add(a2);
        a2.links.add(a1);
        a2.links.add(a3);
        a3.links.add(a2);
        a3.links.add(a4);
        a3.links.add(a5);
        a4.links.add(a3);
        a5.links.add(a3);
        assertThat(busiestHub(a1).val).isEqualTo(3);

        Node b1 = new Node(1);
        Node b2 = new Node(2);
        b1.links.add(b2);
        b2.links.add(b1);
        assertThat(busiestHub(b1).val).isEqualTo(1);
    }

    public Node busiestHub(Node start) {
        Set<Node> seen = new HashSet<>();
        Deque<Node> queue = new ArrayDeque<>();
        seen.add(start);
        queue.add(start);
        Node best = start;
        while (!queue.isEmpty()) {
            Node node = queue.poll();
            if (node.links.size() > best.links.size()
                    || (node.links.size() == best.links.size() && node.val < best.val)) {
                best = node;
            }
            for (Node next : node.links) {
                if (seen.add(next)) {
                    queue.add(next);
                }
            }
        }
        return best;
    }

    class Node {
        public int val;
        public List<Node> links;

        public Node() {
            val = 0;
            links = new ArrayList<Node>();
        }

        public Node(int _val) {
            val = _val;
            links = new ArrayList<Node>();
        }

        public Node(int _val, ArrayList<Node> _links) {
            val = _val;
            links = _links;
        }
    }

}
