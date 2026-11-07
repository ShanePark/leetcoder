package shane.leetcode.problems.medium;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90004StackableCratePairs {

    @Test
    public void test() {
        assertThat(stackablePairs(new int[]{2, 3, 6})).containsExactlyInAnyOrderElementsOf(Ps.intList("[[3,6],[2,6]]"));
        assertThat(stackablePairs(new int[]{5, 7})).isEmpty();
        assertThat(stackablePairs(new int[]{8, 1, 4})).containsExactlyInAnyOrderElementsOf(Ps.intList("[[4,8],[1,8],[1,4]]"));
    }

    public List<List<Integer>> stackablePairs(int[] sizes) {
        int[] sorted = sizes.clone();
        Arrays.sort(sorted);
        List<List<Integer>> answer = new ArrayList<>();
        for (int i = 0; i < sorted.length; i++) {
            for (int j = i + 1; j < sorted.length; j++) {
                if (sorted[j] % sorted[i] == 0) {
                    answer.add(List.of(sorted[i], sorted[j]));
                }
            }
        }
        return answer;
    }

}
