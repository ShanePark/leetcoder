package shane.leetcode.problems.easy;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90014FerryManifestTally {

    @Test
    public void test() {
        assertThat(tallyManifest(Ps.strArray("[[\"van\",\"north\"],[\"bus\",\"south\"],[\"car\",\"north\"]]"))).isEqualTo(Ps.strArray("[[\"north\",\"2\"],[\"south\",\"1\"]]"));
        assertThat(tallyManifest(Ps.strArray("[[\"truck\",\"isle\"]]"))).isEqualTo(Ps.strArray("[[\"isle\",\"1\"]]"));
        assertThat(tallyManifest(Ps.strArray("[[\"car\",\"east\"],[\"van\",\"west\"],[\"bus\",\"west\"],[\"bike\",\"east\"],[\"cab\",\"west\"]]"))).isEqualTo(Ps.strArray("[[\"east\",\"2\"],[\"west\",\"3\"]]"));
    }

    public String[][] tallyManifest(String[][] manifest) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String[] row : manifest) {
            counts.merge(row[1], 1, Integer::sum);
        }
        String[][] answer = new String[counts.size()][];
        int index = 0;
        for (Map.Entry<String, Integer> entry : counts.entrySet()) {
            answer[index++] = new String[]{entry.getKey(), String.valueOf(entry.getValue())};
        }
        return answer;
    }

}
