package shane.leetcode.problems.easy;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90016StationsFeedingATerminal {

    @Test
    public void test() {
        assertThat(countFeeders(Ps.intList("[[1,2],[2],[]]"))).isEqualTo(2);
        assertThat(countFeeders(Ps.intList("[[1],[2],[3],[],[3,0]]"))).isEqualTo(2);
        assertThat(countFeeders(Ps.intList("[[1],[0],[]]"))).isEqualTo(0);
    }

    public int countFeeders(List<List<Integer>> routes) {
        int count = 0;
        for (List<Integer> route : routes) {
            for (int next : route) {
                if (routes.get(next).isEmpty()) {
                    count++;
                    break;
                }
            }
        }
        return count;
    }

}
