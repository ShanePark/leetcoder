pub(super) const GRADLE_INIT_SCRIPT: &str = r#"
import groovy.json.JsonOutput

allprojects {
    plugins.withId('java') {
        if (project == rootProject) {
            tasks.register('leetcoderPrintMainCompileClasspath') {
                doLast {
                    def entries = sourceSets.main.compileClasspath.files.collect { file ->
                        if (!file.exists()) {
                            throw new GradleException("Compile classpath entry does not exist: ${file}")
                        }
                        [path: file.canonicalPath]
                    }
                    println('LEETCODER_PS_CLASSPATH_V1:' + JsonOutput.toJson(entries))
                }
            }
        }
    }
}
"#;

pub(super) const JAVA_HELPER: &str = r#"
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

public class LeetcoderPsMetadata {
    private static final String CLASS_NAME = "io.github.shanepark.Ps";

    public static void main(String[] args) throws Exception {
        List<URL> urls = Arrays.stream(System.getProperty("java.class.path", "").split(
                java.util.regex.Pattern.quote(System.getProperty("path.separator"))))
            .filter(value -> !value.isEmpty())
            .map(Paths::get)
            .map(LeetcoderPsMetadata::toUrl)
            .collect(Collectors.toList());

        List<MethodMetadata> methods = new ArrayList<>();
        try (URLClassLoader loader = new URLClassLoader(urls.toArray(new URL[0]),
                ClassLoader.getPlatformClassLoader())) {
            try {
                Class<?> type = Class.forName(CLASS_NAME, false, loader);
                for (Method method : type.getMethods()) {
                    int modifiers = method.getModifiers();
                    if (!Modifier.isPublic(modifiers) || !Modifier.isStatic(modifiers)
                            || method.isBridge() || method.isSynthetic()) {
                        continue;
                    }
                    java.lang.reflect.Type[] genericTypes = method.getGenericParameterTypes();
                    java.lang.reflect.Parameter[] reflectedParameters = method.getParameters();
                    List<ParameterMetadata> parameters = new ArrayList<>();
                    for (int index = 0; index < genericTypes.length; index++) {
                        String typeName = genericTypes[index].getTypeName();
                        if (method.isVarArgs() && index == genericTypes.length - 1
                                && typeName.endsWith("[]")) {
                            typeName = typeName.substring(0, typeName.length() - 2) + "...";
                        }
                        java.lang.reflect.Parameter parameter = reflectedParameters[index];
                        parameters.add(new ParameterMetadata(
                            parameter.isNamePresent() ? parameter.getName() : null,
                            typeName));
                    }
                    methods.add(new MethodMetadata(method.getName(),
                            method.getGenericReturnType().getTypeName(), parameters));
                }
            } catch (ClassNotFoundException absent) {
                // An absent library is a normal result for projects without the dependency.
            }
        }
        methods.sort(Comparator.comparing(MethodMetadata::sortKey));
        System.out.println("{\"methods\":[" + methods.stream().map(MethodMetadata::toJson)
                    .collect(Collectors.joining(",")) + "]}");
    }

    private static URL toUrl(Path path) {
        try {
            return path.toUri().toURL();
        } catch (Exception exception) {
            throw new IllegalArgumentException("Invalid classpath entry: " + path, exception);
        }
    }

    private static String json(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        for (char character : value.toCharArray()) {
            switch (character) {
                case '"': result.append("\\\""); break;
                case '\\': result.append("\\\\"); break;
                case '\b': result.append("\\b"); break;
                case '\f': result.append("\\f"); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default:
                    if (character < 0x20) result.append(String.format("\\u%04x", (int) character));
                    else result.append(character);
            }
        }
        return result.append('"').toString();
    }

    private static class MethodMetadata {
        private final String name;
        private final String returnType;
        private final List<ParameterMetadata> parameters;
        MethodMetadata(String name, String returnType, List<ParameterMetadata> parameters) {
            this.name = name; this.returnType = returnType; this.parameters = parameters;
        }
        String sortKey() {
            return name + parameters.stream().map(parameter -> parameter.typeName)
                    .collect(Collectors.joining(";", "(", ")")) + returnType;
        }
        String toJson() {
            return "{\"name\":" + json(name) + ",\"returnType\":" + json(returnType)
                    + ",\"parameters\":[" + parameters.stream()
                        .map(ParameterMetadata::toJson).collect(Collectors.joining(",")) + "]}";
        }
    }

    private static class ParameterMetadata {
        private final String name;
        private final String typeName;
        ParameterMetadata(String name, String typeName) {
            this.name = name; this.typeName = typeName;
        }
        String toJson() {
            return "{\"name\":" + json(name) + ",\"typeName\":" + json(typeName) + "}";
        }
    }
}
"#;

pub(super) const JAVA_TYPE_MEMBERS_HELPER: &str = r#"
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.lang.reflect.Type;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

public class LeetcoderJavaTypeMembers {
    public static void main(String[] args) throws Exception {
        String classPath = System.getProperty("java.class.path", "");
        List<URL> urls = Arrays.stream(classPath.split(
                java.util.regex.Pattern.quote(System.getProperty("path.separator"))))
            .filter(value -> !value.isEmpty())
            .map(Paths::get)
            .map(LeetcoderJavaTypeMembers::toUrl)
            .collect(Collectors.toList());

        List<TypeMetadata> types = new ArrayList<>();
        try (URLClassLoader loader = new URLClassLoader(urls.toArray(new URL[0]),
                ClassLoader.getPlatformClassLoader())) {
            for (String requested : args) {
                types.add(inspect(requested, loader));
            }
        }
        System.out.println("{\"types\":[" + types.stream()
                .map(TypeMetadata::toJson).collect(Collectors.joining(",")) + "]}");
    }

    private static TypeMetadata inspect(String requested, ClassLoader loader) {
        List<MethodMetadata> methods = new ArrayList<>();
        List<FieldMetadata> fields = new ArrayList<>();
        try {
            Class<?> type = loadType(requested, loader);
            for (Method method : type.getMethods()) {
                int modifiers = method.getModifiers();
                if (!Modifier.isPublic(modifiers) || method.isBridge() || method.isSynthetic()) {
                    continue;
                }
                Type[] genericTypes = method.getGenericParameterTypes();
                Parameter[] reflectedParameters = method.getParameters();
                List<ParameterMetadata> parameters = new ArrayList<>();
                for (int index = 0; index < genericTypes.length; index++) {
                    String typeName = genericTypes[index].getTypeName();
                    if (method.isVarArgs() && index == genericTypes.length - 1
                            && typeName.endsWith("[]")) {
                        typeName = typeName.substring(0, typeName.length() - 2) + "...";
                    }
                    Parameter parameter = reflectedParameters[index];
                    parameters.add(new ParameterMetadata(
                        parameter.isNamePresent() ? parameter.getName() : null, typeName));
                }
                methods.add(new MethodMetadata(method.getName(),
                        method.getGenericReturnType().getTypeName(), parameters,
                        Modifier.isStatic(modifiers)));
            }
            for (Field field : type.getFields()) {
                int modifiers = field.getModifiers();
                if (!Modifier.isPublic(modifiers)) continue;
                fields.add(new FieldMetadata(field.getName(),
                        field.getGenericType().getTypeName(), Modifier.isStatic(modifiers)));
            }
        } catch (ClassNotFoundException | LinkageError | RuntimeException absentOrUnresolvable) {
            return new TypeMetadata(requested, false, new ArrayList<>(), new ArrayList<>());
        }
        methods.sort(Comparator.comparing(MethodMetadata::sortKey));
        fields.sort(Comparator.comparing(FieldMetadata::sortKey));
        return new TypeMetadata(requested, true, methods, fields);
    }

    private static Class<?> loadType(String name, ClassLoader loader)
            throws ClassNotFoundException {
        try {
            return Class.forName(name, false, loader);
        } catch (ClassNotFoundException original) {
            int separator = name.lastIndexOf('.');
            while (separator > 0) {
                String nestedName = name.substring(0, separator) + "$"
                        + name.substring(separator + 1).replace('.', '$');
                try {
                    return Class.forName(nestedName, false, loader);
                } catch (ClassNotFoundException ignored) {
                    separator = name.lastIndexOf('.', separator - 1);
                }
            }
            throw original;
        }
    }

    private static URL toUrl(java.nio.file.Path path) {
        try {
            return path.toUri().toURL();
        } catch (Exception exception) {
            throw new IllegalArgumentException("Invalid classpath entry: " + path, exception);
        }
    }

    private static String json(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        for (char character : value.toCharArray()) {
            switch (character) {
                case '"': result.append("\\\""); break;
                case '\\': result.append("\\\\"); break;
                case '\b': result.append("\\b"); break;
                case '\f': result.append("\\f"); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default:
                    if (character < 0x20) result.append(String.format("\\u%04x", (int) character));
                    else result.append(character);
            }
        }
        return result.append('"').toString();
    }

    private static class TypeMetadata {
        private final String typeName;
        private final boolean available;
        private final List<MethodMetadata> methods;
        private final List<FieldMetadata> fields;
        TypeMetadata(String typeName, boolean available, List<MethodMetadata> methods,
                List<FieldMetadata> fields) {
            this.typeName = typeName; this.available = available;
            this.methods = methods; this.fields = fields;
        }
        String toJson() {
            return "{\"typeName\":" + json(typeName) + ",\"available\":" + available
                    + ",\"methods\":[" + methods.stream().map(MethodMetadata::toJson)
                        .collect(Collectors.joining(",")) + "],\"fields\":["
                    + fields.stream().map(FieldMetadata::toJson)
                        .collect(Collectors.joining(",")) + "]}";
        }
    }

    private static class MethodMetadata {
        private final String name;
        private final String returnType;
        private final List<ParameterMetadata> parameters;
        private final boolean isStatic;
        MethodMetadata(String name, String returnType, List<ParameterMetadata> parameters,
                boolean isStatic) {
            this.name = name; this.returnType = returnType;
            this.parameters = parameters; this.isStatic = isStatic;
        }
        String sortKey() {
            return name + parameters.stream().map(parameter -> parameter.typeName)
                    .collect(Collectors.joining(";", "(", ")")) + returnType;
        }
        String toJson() {
            return "{\"name\":" + json(name) + ",\"returnType\":" + json(returnType)
                    + ",\"parameters\":[" + parameters.stream()
                        .map(ParameterMetadata::toJson).collect(Collectors.joining(","))
                    + "],\"isStatic\":" + isStatic + "}";
        }
    }

    private static class ParameterMetadata {
        private final String name;
        private final String typeName;
        ParameterMetadata(String name, String typeName) {
            this.name = name; this.typeName = typeName;
        }
        String toJson() {
            return "{\"name\":" + json(name) + ",\"typeName\":" + json(typeName) + "}";
        }
    }

    private static class FieldMetadata {
        private final String name;
        private final String typeName;
        private final boolean isStatic;
        FieldMetadata(String name, String typeName, boolean isStatic) {
            this.name = name; this.typeName = typeName; this.isStatic = isStatic;
        }
        String sortKey() { return name + ":" + typeName + ":" + isStatic; }
        String toJson() {
            return "{\"name\":" + json(name) + ",\"typeName\":" + json(typeName)
                    + ",\"isStatic\":" + isStatic + "}";
        }
    }
}
"#;
