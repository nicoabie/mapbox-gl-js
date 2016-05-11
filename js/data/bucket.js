'use strict';

var featureFilter = require('feature-filter');
var Buffer = require('./buffer');
var util = require('../util/util');
var StructArrayType = require('../util/struct_array');
var VertexArrayObject = require('../render/vertex_array_object');
var assert = require('assert');

module.exports = Bucket;

/**
 * Instantiate the appropriate subclass of `Bucket` for `options`.
 * @private
 * @param options See `Bucket` constructor options
 * @returns {Bucket}
 */
Bucket.create = function(options) {
    var Classes = {
        fill: require('./bucket/fill_bucket'),
        line: require('./bucket/line_bucket'),
        circle: require('./bucket/circle_bucket'),
        symbol: require('./bucket/symbol_bucket')
    };
    return new Classes[options.layer.type](options);
};


/**
 * The maximum extent of a feature that can be safely stored in the buffer.
 * In practice, all features are converted to this extent before being added.
 *
 * Positions are stored as signed 16bit integers.
 * One bit is lost for signedness to support featuers extending past the left edge of the tile.
 * One bit is lost because the line vertex buffer packs 1 bit of other data into the int.
 * One bit is lost to support features extending past the extent on the right edge of the tile.
 * This leaves us with 2^13 = 8192
 *
 * @private
 * @readonly
 */
Bucket.EXTENT = 8192;

/**
 * The `Bucket` class is the single point of knowledge about turning vector
 * tiles into WebGL buffers.
 *
 * `Bucket` is an abstract class. A subclass exists for each Mapbox GL
 * style spec layer type. Because `Bucket` is an abstract class,
 * instances should be created via the `Bucket.create` method.
 *
 * @class Bucket
 * @private
 * @param options
 * @param {number} options.zoom Zoom level of the buffers being built. May be
 *     a fractional zoom level.
 * @param options.layer A Mapbox GL style layer object
 * @param {Object.<string, Buffer>} options.buffers The set of `Buffer`s being
 *     built for this tile. This object facilitates sharing of `Buffer`s be
       between `Bucket`s.
 */
function Bucket(options) {
    this.zoom = options.zoom;
    this.overscaling = options.overscaling;
    this.layer = options.layer;
    this.childLayers = options.childLayers;

    this.type = this.layer.type;
    this.features = [];
    this.id = this.layer.id;
    this.index = options.index;
    this.sourceLayer = this.layer.sourceLayer;
    this.sourceLayerIndex = options.sourceLayerIndex;
    this.minZoom = this.layer.minzoom;
    this.maxZoom = this.layer.maxzoom;

    this.dataLayers = createDataLayers(this);

    if (options.arrays) {
        var childLayers = this.childLayers;
        this.bufferGroups = util.mapObject(options.arrays, function(programArrayGroups, dataLayerTypeName) {
            return programArrayGroups.map(function(programArrayGroup) {

                var group = util.mapObject(programArrayGroup, function(arrays, layoutOrPaint) {
                    return util.mapObject(arrays, function(array, name) {
                        var arrayType = options.arrayTypes[dataLayerTypeName][layoutOrPaint][name];
                        var bufferType = (arrayType.members.length && arrayType.members[0].name === 'vertices' ? Buffer.BufferType.ELEMENT : Buffer.BufferType.VERTEX);
                        return new Buffer(array, arrayType, bufferType);
                    });
                });

                group.vaos = {};
                if (group.layout.element2) group.secondVaos = {};
                for (var l = 0; l < childLayers.length; l++) {
                    var layerName = childLayers[l].id;
                    group.vaos[layerName] = new VertexArrayObject();
                    if (group.layout.element2) group.secondVaos[layerName] = new VertexArrayObject();
                }

                return group;
            });
        });
    }
}

/**
 * Build the buffers! Features are set directly to the `features` property.
 * @private
 */
Bucket.prototype.populateBuffers = function() {
    this.createArrays();
    this.recalculateStyleLayers();

    for (var i = 0; i < this.features.length; i++) {
        this.addFeature(this.features[i]);
    }

    this.trimArrays();
};

/**
 * Check if there is enough space available in the current element group for
 * `vertexLength` vertices. If not, append a new elementGroup. Should be called
 * by `populateBuffers` and its callees.
 * @private
 * @param {string} dataLayerTypeName type of buffer that will receive the vertices
 * @param {number} vertexLength The number of vertices that will be inserted to the buffer.
 * @returns The current element group
 */
Bucket.prototype.makeRoomFor = function(dataLayerTypeName, numVertices) {
    var groups = this.arrayGroups[dataLayerTypeName];
    var currentGroup = groups.length && groups[groups.length - 1];

    if (!currentGroup || currentGroup.layout.vertex.length + numVertices > 65535) {

        var arrayTypes = this.arrayTypes[dataLayerTypeName];
        var VertexArrayType = arrayTypes.layout.vertex;
        var ElementArrayType = arrayTypes.layout.element;
        var ElementArrayType2 = arrayTypes.layout.element2;

        currentGroup = {
            index: groups.length,
            layout: {},
            paint: {}
        };

        currentGroup.layout.vertex = new VertexArrayType();
        if (ElementArrayType) currentGroup.layout.element = new ElementArrayType();
        if (ElementArrayType2) currentGroup.layout.element2 = new ElementArrayType2();

        for (var i = 0; i < this.childLayers.length; i++) {
            var layerName = this.childLayers[i].id;
            var PaintVertexArrayType = arrayTypes.paint[layerName];
            currentGroup.paint[layerName] = new PaintVertexArrayType();
        }

        groups.push(currentGroup);
    }

    return currentGroup;
};

/**
 * Start using a new shared `buffers` object and recreate instances of `Buffer`
 * as necessary.
 * @private
 */
Bucket.prototype.createArrays = function() {
    this.arrayGroups = {};
    this.arrayTypes = {};

    for (var dataLayerTypeName in this.dataLayerTypes) {
        var dataLayerType = this.dataLayerTypes[dataLayerTypeName];
        var programArrayTypes = this.arrayTypes[dataLayerTypeName] = { layout: {}, paint: {} };
        this.arrayGroups[dataLayerTypeName] = [];

        if (dataLayerType.vertexBuffer) {
            var VertexArrayType = new StructArrayType({
                members: this.dataLayerTypes[dataLayerTypeName].layoutAttributes,
                alignment: Buffer.VERTEX_ATTRIBUTE_ALIGNMENT
            });

            programArrayTypes.layout.vertex = VertexArrayType;

            var dataTypeLayers = this.dataLayers[dataLayerTypeName];
            for (var layerName in dataTypeLayers) {
                var PaintVertexArrayType = new StructArrayType({
                    members: dataTypeLayers[layerName].attributes,
                    alignment: Buffer.VERTEX_ATTRIBUTE_ALIGNMENT
                });

                programArrayTypes.paint[layerName] = PaintVertexArrayType;
            }
        }

        if (dataLayerType.elementBuffer) {
            var ElementArrayType = createElementBufferType(dataLayerType.elementBufferComponents);
            programArrayTypes.layout.element = ElementArrayType;
        }

        if (dataLayerType.elementBuffer2) {
            var ElementArrayType2 = createElementBufferType(dataLayerType.elementBuffer2Components);
            programArrayTypes.layout.element2 = ElementArrayType2;
        }
    }
};

Bucket.prototype.destroy = function(gl) {
    for (var dataLayerTypeName in this.bufferGroups) {
        var programBufferGroups = this.bufferGroups[dataLayerTypeName];
        for (var i = 0; i < programBufferGroups.length; i++) {
            var programBuffers = programBufferGroups[i];
            for (var paintBuffer in programBuffers.paint) {
                programBuffers.paint[paintBuffer].destroy(gl);
            }
            for (var layoutBuffer in programBuffers.layout) {
                programBuffers.layout[layoutBuffer].destroy(gl);
            }
            for (var j in programBuffers.vaos) {
                programBuffers.vaos[j].destroy(gl);
            }
            for (var k in programBuffers.secondVaos) {
                programBuffers.secondVaos[k].destroy(gl);
            }
        }
    }

};

Bucket.prototype.trimArrays = function() {
    for (var dataLayerTypeName in this.arrayGroups) {
        var programArrays = this.arrayGroups[dataLayerTypeName];
        for (var paintArray in programArrays.paint) {
            programArrays.paint[paintArray].trim();
        }
        for (var layoutArray in programArrays.layout) {
            programArrays.layout[layoutArray].trim();
        }
    }
};

Bucket.prototype.setUniforms = function(gl, dataLayerTypeName, program, layer, globalProperties) {
    var uniforms = this.dataLayers[dataLayerTypeName][layer.id].uniforms;
    for (var i = 0; i < uniforms.length; i++) {
        var uniform = uniforms[i];
        var uniformLocation = program[uniform.name];
        gl['uniform' + uniform.components + 'fv'](uniformLocation, uniform.getValue(layer, globalProperties));
    }
};

Bucket.prototype.serialize = function() {
    return {
        layerId: this.layer.id,
        zoom: this.zoom,
        arrays: util.mapObject(this.arrayGroups, function(programArrayGroups) {
            return programArrayGroups.map(function(arrayGroup) {
                return util.mapObject(arrayGroup, function(arrays) {
                    return util.mapObject(arrays, function(array) {
                        return array.serialize();
                    });
                });
            });
        }),
        arrayTypes: util.mapObject(this.arrayTypes, function(programArrayTypes) {
            return util.mapObject(programArrayTypes, function(arrayTypes) {
                return util.mapObject(arrayTypes, function(arrayType) {
                    return arrayType.serialize();
                });
            });
        }),

        childLayerIds: this.childLayers.map(function(layer) {
            return layer.id;
        })
    };
};

Bucket.prototype.createFilter = function() {
    if (!this.filter) {
        this.filter = featureFilter(this.layer.filter);
    }
};

var FAKE_ZOOM_HISTORY = { lastIntegerZoom: Infinity, lastIntegerZoomTime: 0, lastZoom: 0 };
Bucket.prototype.recalculateStyleLayers = function() {
    for (var i = 0; i < this.childLayers.length; i++) {
        this.childLayers[i].recalculate(this.zoom, FAKE_ZOOM_HISTORY);
    }
};

Bucket.prototype.populatePaintArrays = function(dataLayerTypeName, globalProperties, featureProperties, startGroup, startIndex) {
    for (var l = 0; l < this.childLayers.length; l++) {
        var layer = this.childLayers[l];
        var groups = this.arrayGroups[dataLayerTypeName];
        for (var g = startGroup.index; g < groups.length; g++) {
            var group = groups[g];
            var length = group.layout.vertex.length;
            var vertexArray = group.paint[layer.id];
            vertexArray.resize(length);

            var attributes = this.dataLayers[dataLayerTypeName][layer.id].attributes;
            for (var m = 0; m < attributes.length; m++) {
                var attribute = attributes[m];

                var value = attribute.getValue(layer, globalProperties, featureProperties);
                var multiplier = attribute.multiplier || 1;
                var components = attribute.components || 1;

                for (var i = startIndex; i < length; i++) {
                    var vertex = vertexArray.get(i);
                    for (var c = 0; c < components; c++) {
                        var memberName = components > 1 ? (attribute.name + c) : attribute.name;
                        vertex[memberName] = value[c] * multiplier;
                    }
                }
            }
        }
    }
};

function createElementBufferType(components) {
    return new StructArrayType({
        members: [{
            type: Buffer.ELEMENT_ATTRIBUTE_TYPE,
            name: 'vertices',
            components: components || 3
        }]
    });
}

function createDataLayers(bucket) {
    var layers = {};

    for (var dataLayerTypeName in bucket.dataLayerTypes) {
        var dataLayerType = bucket.dataLayerTypes[dataLayerTypeName];
        var dataTypeLayers = layers[dataLayerTypeName] = {};

        for (var c = 0; c < bucket.childLayers.length; c++) {
            dataTypeLayers[bucket.childLayers[c].id] = {
                attributes: [],
                uniforms: [],
                defines: [],
                vertexPragmas: {},
                fragmentPragmas: {}
            };
        }

        if (!dataLayerType.paintAttributes) continue;
        for (var i = 0; i < dataLayerType.paintAttributes.length; i++) {
            var attribute = dataLayerType.paintAttributes[i];
            attribute.multiplier = attribute.multiplier || 1;

            for (var j = 0; j < bucket.childLayers.length; j++) {
                var styleLayer = bucket.childLayers[j];
                var layer = dataTypeLayers[styleLayer.id];

                var attributeType = attribute.components === 1 ? 'float' : 'vec' + attribute.components;
                var attributeInputName = attribute.name;
                assert(attribute.name.slice(0, 2) === 'a_');
                var attributeInnerName = attribute.name.slice(2);
                var definePragma = 'define(' + attributeInnerName + ')';
                var initializePragma = 'initialize(' + attributeInnerName + ')';
                var attributeVaryingDefinition;

                layer.fragmentPragmas[initializePragma] = '';

                if (styleLayer.isPaintValueFeatureConstant(attribute.paintProperty)) {
                    layer.uniforms.push(attribute);

                    layer.fragmentPragmas[definePragma] = layer.vertexPragmas[definePragma] = [
                        'uniform',
                        attribute.precision,
                        attributeType,
                        attributeInputName
                    ].join(' ') + ';';

                    layer.fragmentPragmas[initializePragma] = layer.vertexPragmas[initializePragma] = [
                        attribute.precision,
                        attributeType,
                        attributeInnerName,
                        '=',
                        attributeInputName
                    ].join(' ') + ';\n';

                } else if (styleLayer.isPaintValueZoomConstant(attribute.paintProperty)) {
                    layer.attributes.push(util.extend({}, attribute, {
                        name: attributeInputName
                    }));

                    attributeVaryingDefinition = [
                        'varying',
                        attribute.precision,
                        attributeType,
                        attributeInnerName
                    ].join(' ') + ';\n';

                    var attributeAttributeDefinition = [
                        layer.fragmentPragmas[definePragma],
                        'attribute',
                        attribute.precision,
                        attributeType,
                        attributeInputName
                    ].join(' ') + ';\n';

                    layer.fragmentPragmas[definePragma] = attributeVaryingDefinition;

                    layer.vertexPragmas[definePragma] = attributeVaryingDefinition + attributeAttributeDefinition;

                    layer.vertexPragmas[initializePragma] = [
                        attributeInnerName,
                        '=',
                        attributeInputName,
                        '/',
                        attribute.multiplier.toFixed(1)
                    ].join(' ') + ';\n';

                } else {

                    var tName = 'u_' + attributeInputName.slice(2) + '_t';
                    var zoomLevels = styleLayer.getPaintValueStopZoomLevels(attribute.paintProperty);

                    // Pick the index of the first offset to add to the buffers.
                    // Find the four closest stops, ideally with two on each side of the zoom level.
                    var numStops = 0;
                    while (numStops < zoomLevels.length && zoomLevels[numStops] < bucket.zoom) numStops++;
                    var stopOffset = Math.max(0, Math.min(zoomLevels.length - 4, numStops - 2));

                    var fourZoomLevels = [];
                    for (var s = 0; s < 4; s++) {
                        fourZoomLevels.push(zoomLevels[Math.min(stopOffset + s, zoomLevels.length - 1)]);
                    }

                    attributeVaryingDefinition = [
                        'varying',
                        attribute.precision,
                        attributeType,
                        attributeInnerName
                    ].join(' ') + ';\n';

                    layer.vertexPragmas[definePragma] = attributeVaryingDefinition + [
                        'uniform',
                        'lowp',
                        'float',
                        tName
                    ].join(' ') + ';\n';
                    layer.fragmentPragmas[definePragma] = attributeVaryingDefinition;

                    layer.uniforms.push(util.extend({}, attribute, {
                        name: tName,
                        getValue: createUniformGetValue(attribute, stopOffset),
                        components: 1
                    }));

                    var components = attribute.components;
                    if (components === 1) {

                        layer.attributes.push(util.extend({}, attribute, {
                            getValue: createFunctionGetValue(attribute, fourZoomLevels),
                            isFunction: true,
                            components: components * 4
                        }));

                        layer.vertexPragmas[definePragma] += [
                            'attribute',
                            attribute.precision,
                            'vec4',
                            attributeInputName
                        ].join(' ') + ';\n';

                        layer.vertexPragmas[initializePragma] = [
                            attributeInnerName,
                            '=',
                            'evaluate_zoom_function_1(' + attributeInputName + ', ' + tName + ')',
                            '/',
                            attribute.multiplier.toFixed(1)
                        ].join(' ') + ';\n';

                    } else {

                        var attributeInputNames = [];
                        for (var k = 0; k < 4; k++) {
                            attributeInputNames.push(attributeInputName + k);
                            layer.attributes.push(util.extend({}, attribute, {
                                getValue: createFunctionGetValue(attribute, [fourZoomLevels[k]]),
                                isFunction: true,
                                name: attributeInputName + k
                            }));
                            layer.vertexPragmas[definePragma] += [
                                'attribute',
                                attribute.precision,
                                attributeType,
                                attributeInputName + k
                            ].join(' ') + ';\n';
                        }
                        layer.vertexPragmas[initializePragma] = [
                            attributeInnerName,
                            ' = ',
                            'evaluate_zoom_function_4(' + attributeInputNames.join(', ') + ', ' + tName + ')',
                            '/',
                            attribute.multiplier.toFixed(1)
                        ].join(' ') + ';\n';
                    }
                }
            }
        }
    }
    return layers;
}

function createFunctionGetValue(attribute, stopZoomLevels) {
    return function(layer, globalProperties, featureProperties) {
        if (stopZoomLevels.length === 1) {
            // return one multi-component value like color0
            return attribute.getValue(layer, util.extend({}, globalProperties, { zoom: stopZoomLevels[0] }), featureProperties);
        } else {
            // pack multiple single-component values into a four component attribute
            var values = [];
            for (var z = 0; z < stopZoomLevels.length; z++) {
                var stopZoomLevel = stopZoomLevels[z];
                values.push(attribute.getValue(layer, util.extend({}, globalProperties, { zoom: stopZoomLevel }), featureProperties)[0]);
            }
            return values;
        }
    };
}

function createUniformGetValue(attribute, stopOffset) {
    return function(layer, globalProperties) {
        // stopInterp indicates which stops need to be interpolated.
        // If stopInterp is 3.5 then interpolate half way between stops 3 and 4.
        var stopInterp = layer.getPaintInterpolationT(attribute.paintProperty, globalProperties.zoom);
        // We can only store four stop values in the buffers. stopOffset is the number of stops that come
        // before the stops that were added to the buffers.
        return [Math.max(0, Math.min(4, stopInterp - stopOffset))];
    };
}
