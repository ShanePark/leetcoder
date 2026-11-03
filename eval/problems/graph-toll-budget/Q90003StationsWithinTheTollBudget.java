package shane.leetcode.problems.medium;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.PriorityQueue;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90003StationsWithinTheTollBudget {

    @Test
    public void test() {
        assertThat(stationsWithinBudget(4, Ps.intArray("[[0,1,3],[1,2,4],[0,3,10]]"), 0, 7)).isEqualTo(3);
        assertThat(stationsWithinBudget(3, Ps.intArray("[[0,1,5]]"), 2, 100)).isEqualTo(1);
        assertThat(stationsWithinBudget(5, Ps.intArray("[[0,1,2],[1,2,2],[0,2,9],[2,3,1],[3,4,6]]"), 0, 5)).isEqualTo(4);
    }

    public int stationsWithinBudget(int n, int[][] tunnels, int start, int budget) {
        List<List<int[]>> graph = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            graph.add(new ArrayList<>());
        }
        for (int[] tunnel : tunnels) {
            graph.get(tunnel[0]).add(new int[]{tunnel[1], tunnel[2]});
            graph.get(tunnel[1]).add(new int[]{tunnel[0], tunnel[2]});
        }

        int[] cost = new int[n];
        Arrays.fill(cost, Integer.MAX_VALUE);
        cost[start] = 0;
        PriorityQueue<int[]> queue = new PriorityQueue<>((a, b) -> a[1] - b[1]);
        queue.add(new int[]{start, 0});
        while (!queue.isEmpty()) {
            int[] current = queue.poll();
            if (current[1] > cost[current[0]]) {
                continue;
            }
            for (int[] next : graph.get(current[0])) {
                int nextCost = current[1] + next[1];
                if (nextCost < cost[next[0]]) {
                    cost[next[0]] = nextCost;
                    queue.add(new int[]{next[0], nextCost});
                }
            }
        }

        int count = 0;
        for (int value : cost) {
            if (value <= budget) {
                count++;
            }
        }
        return count;
    }

}
