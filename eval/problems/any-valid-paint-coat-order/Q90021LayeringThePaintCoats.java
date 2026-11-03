package shane.leetcode.problems.medium;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.PriorityQueue;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90021LayeringThePaintCoats {

    @Test
    public void test() {
        assertThat(coatOrder(6, Ps.intArray("[[5,0],[5,2],[0,3],[2,3],[3,1],[4,1]]")))
                .containsExactly(4, 5, 0, 2, 3, 1);
        assertThat(coatOrder(5, Ps.intArray("[[1,0],[2,0],[3,1],[3,2],[4,3]]")))
                .containsExactly(4, 3, 1, 2, 0);
    }

    public int[] coatOrder(int coats, int[][] under) {
        List<List<Integer>> above = new ArrayList<>();
        for (int coat = 0; coat < coats; coat++) {
            above.add(new ArrayList<>());
        }
        int[] waiting = new int[coats];
        for (int[] entry : under) {
            above.get(entry[0]).add(entry[1]);
            waiting[entry[1]]++;
        }
        PriorityQueue<Integer> ready = new PriorityQueue<>();
        for (int coat = 0; coat < coats; coat++) {
            if (waiting[coat] == 0) {
                ready.add(coat);
            }
        }
        int[] order = new int[coats];
        for (int position = 0; position < coats; position++) {
            int coat = ready.poll();
            order[position] = coat;
            for (int next : above.get(coat)) {
                if (--waiting[next] == 0) {
                    ready.add(next);
                }
            }
        }
        return order;
    }

}
