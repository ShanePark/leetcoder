package shane.leetcode.problems.medium;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90018RainBarrelCascade {

    @Test
    public void test() {
        assertThat(fullestBarrel(Ps.intList("[[2],[3,1],[1,5,2]]"))).isEqualTo(10);
        assertThat(fullestBarrel(Ps.intList("[[7]]"))).isEqualTo(7);
        assertThat(fullestBarrel(Ps.intList("[[1],[2,9],[4,1,3],[1,1,1,6]]"))).isEqualTo(19);
    }

    public int fullestBarrel(List<List<Integer>> tiers) {
        for (int tier = 1; tier < tiers.size(); tier++) {
            List<Integer> above = tiers.get(tier - 1);
            List<Integer> row = tiers.get(tier);
            for (int barrel = 0; barrel < row.size(); barrel++) {
                int fromLeft = barrel > 0 ? above.get(barrel - 1) : 0;
                int fromRight = barrel < above.size() ? above.get(barrel) : 0;
                row.set(barrel, row.get(barrel) + Math.max(fromLeft, fromRight));
            }
        }
        return Collections.max(tiers.get(tiers.size() - 1));
    }

}
