package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.TreeSet;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90012CoatCheckCounter {

    @Test
    public void test() {
        CoatCheck coatCheck = new CoatCheck(2);
        assertThat(coatCheck.hang("ann")).isEqualTo(1);
        assertThat(coatCheck.hang("bo")).isEqualTo(2);
        assertThat(coatCheck.collect("ann")).isEqualTo(1);
        assertThat(coatCheck.hang("cy")).isEqualTo(1);

        CoatCheck coatCheck2 = new CoatCheck(1);
        assertThat(coatCheck2.hang("ann")).isEqualTo(1);
        assertThat(coatCheck2.hang("bo")).isEqualTo(-1);
        coatCheck2.clear();
        assertThat(coatCheck2.collect("ann")).isEqualTo(-1);
        assertThat(coatCheck2.hang("bo")).isEqualTo(1);
    }

    class CoatCheck {
        private final int hooks;
        private final TreeSet<Integer> free = new TreeSet<>();
        private final Map<String, Integer> held = new HashMap<>();

        public CoatCheck(int hooks) {
            this.hooks = hooks;
            clear();
        }

        public int hang(String owner) {
            if (free.isEmpty()) {
                return -1;
            }
            int hook = free.pollFirst();
            held.put(owner, hook);
            return hook;
        }

        public int collect(String owner) {
            Integer hook = held.remove(owner);
            if (hook == null) {
                return -1;
            }
            free.add(hook);
            return hook;
        }

        public void clear() {
            held.clear();
            for (int hook = 1; hook <= hooks; hook++) {
                free.add(hook);
            }
        }
    }

}
