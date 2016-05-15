// box fragment shader uses the _same_ vertex shader as text.vertex.glsl
precision mediump float;

uniform sampler2D u_fadetexture;
uniform lowp float u_opacity;

varying vec2 v_fade_tex;
varying float v_angle_alpha;

void main() {
    lowp float fade_alpha = texture2D(u_fadetexture, v_fade_tex).a;
    lowp float alpha = min(v_angle_alpha, fade_alpha);
    gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0) * (alpha * u_opacity);

#ifdef OVERDRAW_INSPECTOR
    gl_FragColor = vec4(1.0);
#endif
}
