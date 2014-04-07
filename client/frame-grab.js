(function() {

    var Promise = RSVP.Promise,

        /**
         * Supported options object properties:
         *
         * - `video`: (HTMLVideoElement) - [REQUIRED] The source video
         * - `frame_rate`: (Float) - [REQUIRED] The frame rate of the video
         * - `skip_solids.enabled`: (Boolean) - [false] True if you want to skip past frames that are mostly solid.
         * - `skip_solids.frames`: (Integer) - [5] Number of frames to skip ahead when a solid frame is found.
         * - `skip_solids.max_ratio`: (Float) - [0.95] If the frame contains more solid pixels, it will be skipped.
         */
        FrameGrab = function(user_passed_opts) {
            var options = this._normalize_options(user_passed_opts);

            if (!this._is_element(options.video, "video")) {
                throw new Error("You must pass a valid <video>!");
            }
            if (!options.frame_rate || options.frame_rate < 0) {
                throw new Error("Invalid frame rate of " + options.frame_rate);
            }

            var video_clone = this._clone_video(options.video),
                clone_ready = new Promise(function(resolve) {
                    video_clone.addEventListener("canplaythrough", function() {
                        resolve();
                    });
                });

            this.grab = function(target_container, time, opt_max_size) {
                if (!this._is_element(target_container, "img") &&
                    !this._is_element(target_container, "canvas")) {

                    throw new Error("Target container must be an <img> or <canvas>!");
                }

                var grab_deferred = new RSVP.defer(),
                    time_in_secs = this._normalize_time(time, options.frame_rate);

                clone_ready.then(function() {
                    var temp_canvas = document.createElement("canvas");

                    this._draw_specific_frame({
                        canvas: temp_canvas,
                        frame_rate: options.frame_rate,
                        max_size: opt_max_size,
                        skip_solids: options.skip_solids,
                        time_in_secs: time_in_secs,
                        video: video_clone
                    }).then(
                        // draw success
                        function() {
                            // If a canvas is user-supplied, draw onto a temp canvas
                            // and then draw the final image onto the passed canvas
                            // to avoid flickering in case we need to adjust the time
                            // to a non-solid frame.
                            if (this._is_element(target_container, "canvas")) {
                                var target_context = target_container.getContext("2d");

                                target_container.width = temp_canvas.width;
                                target_container.height = temp_canvas.height;

                                target_context.drawImage(temp_canvas, 0, 0);

                                grab_deferred.resolve(target_container);
                            }
                            else {
                                target_container.onload = function() {
                                    grab_deferred.resolve(target_container);
                                };
                                target_container.onerror = function() {
                                    grab_deferred.reject("Frame failed to load in <img>.");
                                };
                                target_container.src = temp_canvas.toDataURL();
                            }
                        }.bind(this),

                        // draw failure
                        grab_deferred.reject
                    );
                }.bind(this));

                return grab_deferred.promise;
            };
        };

    FrameGrab.prototype = {
        _calculate_scaled_dimensions: function(video, max_size) {
            if (max_size >= video.videoWidth && max_size >= video.videoHeight) {
                return {
                    height: video.videoHeight,
                    width: video.videoWidth
                };
            }

            var aspect_ratio = video.videoHeight / video.videoWidth,
                scaled_size = aspect_ratio * max_size;

            return {
                height: scaled_size,
                width: max_size
            };
        },

        // Most of this is a workaround for a bug in Chrome
        // that causes the loading of the cloned video to stall
        _clone_video: function(video) {
            var clone = video.cloneNode(true),
                videoSrc = clone.getAttribute("src");

            if (videoSrc) {
                clone.setAttribute("src", this._uncacheable_url(videoSrc));
            }
            else {
                (function() {
                    var source_els = clone.getElementsByTagName("source"),
                        currentElement, srcAttr, idx;

                    for (idx = 0; idx < source_els.length; idx++) {
                        currentElement = source_els[idx];
                        srcAttr = currentElement.getAttribute("src");

                        if (srcAttr) {
                            currentElement.setAttribute("src",
                                this._uncacheable_url(srcAttr));
                        }
                    }
                }.bind(this)());
            }

            // Not all impls of HTMLMediaElement include load() (i.e. phantomjs)
            clone.load && clone.load();
            return clone;
        },

        _draw: function(video, canvas, opt_max_size) {
            var context = canvas.getContext("2d"),
                target_dim = {
                    height: video.videoHeight,
                    width: video.videoWidth
                };

            if (opt_max_size) {
                target_dim = this._calculate_scaled_dimensions(video, opt_max_size);
            }
            canvas.width = target_dim.width;
            canvas.height = target_dim.height;

            context.drawImage(video, 0, 0, target_dim.width, target_dim.height);

            return canvas;
        },

        _draw_specific_frame: function(spec) {
            var canvas = spec.canvas,
                deferred = spec.deferred || RSVP.defer(),
                frame_rate = spec.frame_rate,
                frames_to_skip = spec.skip_solids.frames.toString(),
                max_size = spec.max_size,
                max_solid_ratio = spec.skip_solids.max_ratio,
                skip_solids = spec.skip_solids.enabled,
                time_in_secs = spec.time_in_secs,
                video = spec.video;

            this._seek(video, time_in_secs).then(
                // seek success
                function() {
                    this._draw(video, canvas, max_size);

                    if (skip_solids && this._is_solid_color(video, max_solid_ratio)) {
                        (function() {
                            var jump_frames_in_secs =
                                this._normalize_time(frames_to_skip, frame_rate);

                            spec.time_in_secs += jump_frames_in_secs;
                            spec.deferred = deferred;
                            console.log("Found a solid frame, advancing 5 frames to find a non-solid one");
                            this._draw_specific_frame(spec);
                        }.bind(this)());
                    }
                    else {
                        deferred.resolve(canvas);
                    }
                }.bind(this),
                function() {
                    console.error("Failed to seek in _draw_specific_frame!");
                    deferred.reject("Seek failure!");
                }
            );

            return deferred.promise;
        },

        _is_element: function(el, type) {
            return el != null &&
                el.tagName != null &&
                el.tagName.toLowerCase() === type;
        },

        // That is, detect ALL solid colors and colors that are near-solid.
        _is_solid_color: function(video, max_solid_ratio) {
                // re-draw the frame onto the canvas at a minimal size
                // to speed up image data parsing
            var canvas = this._draw(video, document.createElement("canvas"), 10),
                context = canvas.getContext("2d"),
                image_data = context.getImageData(0, 0, canvas.width, canvas.height),
                pixel_data = image_data.data,
                solid_occurrences = 0,
                pixel_index, red, green, blue, alpha;

            for (var i = 0; i < pixel_data.length; i++) {
                pixel_index = 4 * i;

                red = pixel_data[pixel_index++];
                green = pixel_data[pixel_index++];
                blue = pixel_data[pixel_index++];
                alpha = pixel_data[pixel_index];

                // We only currently look for solid or near-solid black
                if (alpha === 255 &&
                    Math.abs(red - green) < 30 &&
                    Math.abs(green - blue) < 30) {

                    solid_occurrences++;
                }
            }

            // If at least 95% of the frame is solid black, return true
            return (solid_occurrences / (pixel_data.length / 4) > max_solid_ratio);
        },

        _normalize_options: function(user_passed_options) {
            var options = {
                video: user_passed_options.video,
                frame_rate: user_passed_options.frame_rate,
                skip_solids: {
                    enabled: false,
                    frames: 5,
                    max_ratio: 0.95
                }
            };

            if (user_passed_options.skip_solids) {
                options.skip_solids.enabled = user_passed_options.skip_solids.enabled;

                options.skip_solids.frames = user_passed_options.skip_solids.frames ||
                    options.skip_solids.frames;

                options.skip_solids.max_ratio = user_passed_options.skip_solids.max_ratio ||
                    options.skip_solids.max_ratio;
            }

            return options;
        },

        _normalize_time: function(time, frame_rate) {
            if (typeof time === "number") {
                return parseFloat(time);
            }
            else if (typeof time === "string" &&
                typeof frame_rate === "number" &&
                frame_rate > 0) {

                return this._timecode_to_secs(time, frame_rate);
            }
            else {
                throw new Error("Invalid time or frame rate");
            }
        },

        _seek: function(video, secs) {
            return new Promise(function(resolve, reject) {
                var seek_complete = function() {
                    video.removeEventListener("seeked", seek_complete);
                    resolve(video);
                };

                if (video.duration < secs) {
                    reject("Target time exceeds the video length");
                }
                else {
                    video.addEventListener("seeked", seek_complete);
                    video.currentTime = secs;
                }
            });
        },

        _timecode_to_secs: function(timecode, frame_rate) {
            if(!/^(\d{1,2}:)?(\d{1,2}:)?(\d{1,2}:)?\d{1,2}$/.test(timecode)) {
                throw new Error(timecode + " is not a valid timecode!");
            }

            var segments = timecode.split(":").reverse(),
                secs_per_frame = 1 / frame_rate,
                secs = 0,
                segment_int;

            for (var i = 3; i >= 0; i--) {
                segment_int = parseInt(segments[i]);

                switch (i) {
                    case 0:
                        secs += segment_int * secs_per_frame;
                        break;
                    case 1:
                        if (segments.length >= 2) {
                            secs += segment_int;
                        }
                        break;
                    case 2:
                        if (segments.length >= 3) {
                            secs += segment_int * 60;
                        }
                        break;
                    case 3:
                        if (segments.length === 4) {
                            secs += segment_int * 60 * 60;
                        }
                        break;
                }
            }

            return secs;
        },

        _uncacheable_url: function(url) {
            var param_prefix = url.indexOf("?") > 0 ? "&" : "?";

            return url + param_prefix +
                "fgtimestamp=" + new Date().getMilliseconds();
        }
    };

    this.FrameGrab = FrameGrab;
}());