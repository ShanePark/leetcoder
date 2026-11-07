package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90023FurthestChannelsOfTheDelta {

    @Test
    public void test() {
        Node low1 = new Node(1);
        Node low7 = new Node(7);
        Node low13 = new Node(13);
        Node mid8 = new Node(8, List.of(low1));
        Node mid5 = new Node(5, List.of(low7, low13));
        Node spring = new Node(2, List.of(mid8, mid5));
        assertThat(furthestChannels(spring)).containsExactly(1, 7, 13);

        assertThat(furthestChannels(new Node(6))).containsExactly(6);

        Node low14 = new Node(14);
        Node mid12 = new Node(12);
        Node mid10 = new Node(10, List.of(low14));
        Node mid9 = new Node(9, List.of(mid12, mid10));
        Node spring3 = new Node(4, List.of(mid9));
        assertThat(furthestChannels(spring3)).containsExactly(14);
    }

    public List<Integer> furthestChannels(Node spring) {
        List<Node> level = List.of(spring);
        while (true) {
            List<Node> below = new ArrayList<>();
            for (Node node : level) {
                // The one-argument constructor leaves children null.
                if (node.children != null) {
                    below.addAll(node.children);
                }
            }
            if (below.isEmpty()) {
                List<Integer> values = new ArrayList<>();
                for (Node node : level) {
                    values.add(node.val);
                }
                return values;
            }
            level = below;
        }
    }

    class Node {
        public int val;
        public List<Node> children;

        public Node() {
        }

        public Node(int _val) {
            val = _val;
        }

        public Node(int _val, List<Node> _children) {
            val = _val;
            children = _children;
        }
    }

}
