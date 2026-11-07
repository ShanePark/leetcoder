package shane.leetcode.problems.medium;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90027BinSweeper {

    @Test
    public void test() {
        BinSweeper binSweeper = new BinSweeper(Ps.intList("[[8,2],[],[6]]"));
        assertThat(binSweeper.hasNext()).isTrue();
        assertThat(binSweeper.next()).isEqualTo(8);
        assertThat(binSweeper.next()).isEqualTo(6);
        assertThat(binSweeper.next()).isEqualTo(2);
        assertThat(binSweeper.hasNext()).isFalse();

        BinSweeper binSweeper2 = new BinSweeper(Ps.intList("[[11],[14,16,19]]"));
        assertThat(binSweeper2.next()).isEqualTo(11);
        assertThat(binSweeper2.next()).isEqualTo(14);
        assertThat(binSweeper2.hasNext()).isTrue();
        assertThat(binSweeper2.next()).isEqualTo(16);
        assertThat(binSweeper2.next()).isEqualTo(19);
        assertThat(binSweeper2.hasNext()).isFalse();

        BinSweeper binSweeper3 = new BinSweeper(Ps.intList("[[],[]]"));
        assertThat(binSweeper3.hasNext()).isFalse();
    }

    class BinSweeper {
        private final Deque<Iterator<Integer>> round = new ArrayDeque<>();

        public BinSweeper(List<List<Integer>> bins) {
            for (List<Integer> bin : bins) {
                if (!bin.isEmpty()) {
                    round.add(bin.iterator());
                }
            }
        }

        public boolean hasNext() {
            return !round.isEmpty();
        }

        public int next() {
            Iterator<Integer> bin = round.poll();
            int parcel = bin.next();
            if (bin.hasNext()) {
                round.add(bin);
            }
            return parcel;
        }
    }

}
