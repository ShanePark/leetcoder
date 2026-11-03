package shane.leetcode.problems.easy;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90015GuestBookCleanup {

    @Test
    public void test() {
        assertThat(cleanPages(Ps.strList("[[\"ana\",\"bo\",\"ana\"],[\"cy\"]]"))).isEqualTo(Ps.strList("[[\"ana\",\"bo\"],[\"cy\"]]"));
        assertThat(cleanPages(List.of(List.of("Doe, Jo", "Lee, Max", "Doe, Jo")))).isEqualTo(List.of(List.of("Doe, Jo", "Lee, Max")));
        assertThat(cleanPages(Ps.strList("[[\"kim\",\"kim\"],[\"raj\",\"uma\",\"raj\",\"kim\"]]"))).isEqualTo(Ps.strList("[[\"kim\"],[\"raj\",\"uma\",\"kim\"]]"));
    }

    public List<List<String>> cleanPages(List<List<String>> pages) {
        List<List<String>> answer = new ArrayList<>();
        for (List<String> page : pages) {
            answer.add(new ArrayList<>(new LinkedHashSet<>(page)));
        }
        return answer;
    }

}
