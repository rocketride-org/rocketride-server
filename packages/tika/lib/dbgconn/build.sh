export JAVA_ROOT=$(cd ../../../../vcpkg/installed/java && pwd)
export JAVA_HOME=$JAVA_ROOT/jdk
export JAVA_MAVEN=$JAVA_ROOT/maven/bin/mvn

$JAVA_MAVEN clean compile assembly:single -q || exit 1
$JAVA_MAVEN test -q || exit 1
