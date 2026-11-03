import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.StringWriter;
import java.lang.annotation.Annotation;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Grades a batch of prompt eval sources in one JVM. Each case compiles into its own
 * directory and loads in its own class loader, so a bad case only fails itself.
 *
 * Arguments: batch directory, per-test timeout in ms, source level, target level, compile
 * classpath. The JVM's own classpath is the test runtime classpath. The batch directory
 * holds cases.tsv (id, class name, case directory), and each case directory holds its file
 * under src/. Results go to results.jsonl, written after each case so a dead JVM keeps them.
 */
public class JavaGradeRunner {
    private static final class Result {
        final String status;
        final String detail;

        Result(String status, String detail) {
            this.status = status;
            this.detail = detail;
        }
    }

    public static void main(String[] args) throws Exception {
        Path batch = Path.of(args[0]);
        long timeoutMs = Long.parseLong(args[1]);
        List<String> options = List.of(
            "-source", args[2], "-target", args[3], "-classpath", args[4],
            "-encoding", "UTF-8", "-g", "-proc:none");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();

        // A solution may print without end, and nothing reads its output.
        PrintStream discard = new PrintStream(OutputStream.nullOutputStream());
        System.setOut(discard);
        System.setErr(discard);

        Path resultsPath = batch.resolve("results.jsonl");
        try (BufferedWriter results = Files.newBufferedWriter(resultsPath, StandardCharsets.UTF_8)) {
            for (String line : Files.readAllLines(batch.resolve("cases.tsv"), StandardCharsets.UTF_8)) {
                String[] row = line.split("\t");
                Result result = gradeCase(compiler, options, row[1], Path.of(row[2]), timeoutMs);
                results.write("{\"id\":" + json(row[0]) + ",\"status\":" + json(result.status)
                    + ",\"detail\":" + json(result.detail) + "}");
                results.newLine();
                results.flush();
            }
        }
        // A timed-out test may still be running, or a solution may have left threads behind.
        Runtime.getRuntime().halt(0);
    }

    private static Result gradeCase(
        JavaCompiler compiler, List<String> options, String className, Path directory, long timeoutMs
    ) {
        try {
            Path classes = Files.createDirectories(directory.resolve("classes"));
            Path source = directory.resolve("src").resolve(className.replace('.', '/') + ".java");
            String errors = compile(compiler, options, source, classes);
            return errors != null
                ? new Result("compile", errors)
                : runTest(classes, className, timeoutMs);
        } catch (Throwable error) {
            return new Result("tool", error.toString());
        }
    }

    /** The compiler's output when compiling fails, or null when it succeeds. */
    private static String compile(JavaCompiler compiler, List<String> options, Path source, Path classes)
        throws IOException {
        List<String> caseOptions = new ArrayList<>(options);
        caseOptions.addAll(List.of("-d", classes.toString()));
        StringWriter output = new StringWriter();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler
                .getTask(output, files, null, caseOptions, null, files.getJavaFileObjects(source))
                .call();
            return compiled ? null : output.toString();
        }
    }

    @SuppressWarnings({"deprecation", "removal"})
    private static Result runTest(Path classes, String className, long timeoutMs) throws Exception {
        URL[] urls = {classes.toUri().toURL()};
        try (URLClassLoader loader = new URLClassLoader(urls, ClassLoader.getSystemClassLoader())) {
            Result[] outcome = new Result[1];
            Thread worker = new Thread(() -> outcome[0] = invokeTest(loader, className), "Test worker");
            worker.setDaemon(true);
            worker.setContextClassLoader(loader);
            worker.start();
            worker.join(timeoutMs);
            if (worker.isAlive()) {
                // Left running, a looping solution would use a core or the heap for the rest of the batch.
                worker.stop();
                return new Result("timeout", "The test did not finish within " + timeoutMs / 1000 + " seconds.");
            }
            return outcome[0];
        }
    }

    /** Only `test` runs, because the other tests in a solved file are not part of the grade. */
    private static Result invokeTest(ClassLoader loader, String className) {
        try {
            Class<?> type = Class.forName(className, true, loader);
            Method test;
            try {
                test = type.getDeclaredMethod("test");
            } catch (NoSuchMethodException missing) {
                return new Result("tool", "No @Test method named test.");
            }
            if (!isTest(test)) {
                return new Result("tool", "No @Test method named test.");
            }
            Constructor<?> constructor = type.getDeclaredConstructor();
            constructor.setAccessible(true);
            test.setAccessible(true);
            test.invoke(constructor.newInstance());
            return new Result("pass", "");
        } catch (InvocationTargetException thrown) {
            return failure(thrown.getCause());
        } catch (Throwable thrown) {
            return failure(thrown);
        }
    }

    private static boolean isTest(Method method) {
        for (Annotation annotation : method.getAnnotations()) {
            if (annotation.annotationType().getName().equals("org.junit.jupiter.api.Test")) {
                return true;
            }
        }
        return false;
    }

    private static Result failure(Throwable thrown) {
        return new Result("failure", thrown + " " + thrown.getClass().getName());
    }

    private static String json(String text) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            if (c == '"' || c == '\\') {
                out.append('\\').append(c);
            } else if (c < 0x20) {
                out.append(String.format("\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        return out.append('"').toString();
    }
}
